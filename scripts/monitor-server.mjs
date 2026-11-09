/**
 * my-homepage 监控网关 —— 多机指标采集 + 目录归属聚合 + 告警 + Web SSH 终端
 *
 * 设计文档：docs/monitor-terminal-blueprint.md
 * 依赖：ssh2（远程采集 + 终端通道）、ws（终端 WebSocket）；其余全部 Node 内置。
 * 监听：127.0.0.1:8301（仅回环，对外一律经 nginx /api/monitor/ 与 /api/terminal）
 *
 * 目录归属规则（按优先级）：
 *   1) /proc/<pid>/cwd 命中跟踪目录  2) exe 命中
 *   3) cmdline 含目录前缀           4) cgroup → docker 容器 → compose 工作目录/镜像名
 * 未命中跟踪目录的进程不入库、不出现在任何接口（不越界采集）。
 *
 * CLI：
 *   node scripts/monitor-server.mjs                                        # 启动服务
 *   echo '新密码' | node scripts/monitor-server.mjs --set-password-stdin
 *   echo '目标机密码' | node scripts/monitor-server.mjs --set-cred <hostId> --password-stdin
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Client as SSHClient } from 'ssh2';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'scripts', 'monitor.config.json');
const APPS_CONFIG_PATH = path.join(ROOT, 'scripts', 'apps.config.json');
const DATA_DIR = path.join(ROOT, 'data', 'monitor');
const SECRET_PATH = path.join(DATA_DIR, '.secret');
const CREDS_PATH = path.join(DATA_DIR, 'credentials.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.jsonl');
const ALERTS_PATH = path.join(DATA_DIR, 'alerts.jsonl');
const INITIAL_PW_PATH = path.join(DATA_DIR, 'INITIAL_PASSWORD.txt');
const COOKIE_NAME = 'mh_mon';
const CPU_DELTA_MIN = 1; // 防 0 除的最小 jiffy 差

/* ============================ 小工具 ============================ */
const nowIso = () => new Date().toISOString();
function log(...args) { console.log(nowIso(), '[monitor]', ...args); }
function ensureDirSync(d) { fs.mkdirSync(d, { recursive: true }); }
function appendJsonl(file, obj) {
  try {
    ensureDirSync(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) { log('appendJsonl failed:', e.message); }
}

/* ============================ 配置 ============================ */
const DEFAULTS = {
  port: 8301,
  auth: { sessionTtlHours: 12, maxFailPerMin: 5 },
  collect: { localIntervalSec: 5, remoteIntervalSec: 20, retentionDays: 7, dockerRefreshSec: 30 },
  thresholds: { cpuPct: 85, memPct: 90, diskPct: 90, loadPerCore: 2, sustainMin: 3 },
  terminal: { idleTimeoutMin: 15, maxSessionMin: 240, maxSessionsPerHost: 2, recordCommands: true },
  webhookUrl: '',
  hosts: [],
  trackedDirs: [],
};
const HOST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeHost(h) {
  if (!h || typeof h !== 'object' || !h.id) return null;
  if (!HOST_ID_RE.test(String(h.id))) return null;
  const out = { id: String(h.id), name: String(h.name || h.id), type: h.type === 'local' ? 'local' : 'ssh', group: String(h.group || '内网') };
  if (out.type === 'local') {
    out.address = String(h.address || '127.0.0.1');
    out.terminal = h.terminal && typeof h.terminal === 'object' ? {
      host: String(h.terminal.host || '127.0.0.1'),
      port: Number(h.terminal.port) > 0 ? Number(h.terminal.port) : 22,
      username: String(h.terminal.username || 'root'),
      authType: h.terminal.authType === 'password' ? 'password' : 'key',
      keyPath: h.terminal.keyPath ? String(h.terminal.keyPath) : '',
    } : null;
  } else {
    out.address = String(h.address || '');
    out.port = Number(h.port) > 0 ? Number(h.port) : 22;
    out.username = String(h.username || 'root');
    out.authType = h.authType === 'password' ? 'password' : 'key';
    out.keyPath = h.keyPath ? String(h.keyPath) : '';
  }
  if (h.note) out.note = String(h.note);
  return out;
}

function loadConfigSync() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = { $comment: raw.$comment, ...DEFAULTS, ...raw };
  cfg.auth = { ...DEFAULTS.auth, ...(raw.auth || {}) };
  cfg.collect = { ...DEFAULTS.collect, ...(raw.collect || {}) };
  cfg.thresholds = { ...DEFAULTS.thresholds, ...(raw.thresholds || {}) };
  cfg.terminal = { ...DEFAULTS.terminal, ...(raw.terminal || {}) };
  cfg.hosts = Array.isArray(raw.hosts) ? raw.hosts.map(normalizeHost).filter(Boolean) : [];
  const seen = new Set();
  cfg.hosts = cfg.hosts.filter(h => (seen.has(h.id) ? false : (seen.add(h.id), true)));
  cfg.trackedDirs = (Array.isArray(raw.trackedDirs) ? raw.trackedDirs : [])
    .map(d => (typeof d === 'string' ? { path: d } : d))
    .filter(d => d && d.path && path.isAbsolute(d.path) && path.resolve(d.path) !== '/')
    .map(d => ({ path: path.resolve(d.path), name: String(d.name || path.basename(d.path)), source: 'custom' }));
  return cfg;
}

let config = loadConfigSync();
// 主页登记应用的目录自动并入跟踪（source: homepage），无需重复配置
let homepageDirs = [];
function reloadHomepageDirs() {
  try {
    const raw = JSON.parse(fs.readFileSync(APPS_CONFIG_PATH, 'utf8'));
    homepageDirs = (raw.apps || [])
      .filter(a => a && a.id && a.directory && !a.exclude)
      .map(a => ({ path: path.resolve(a.directory), name: String(a.name || a.id), source: 'homepage' }));
  } catch { homepageDirs = []; }
}
function effectiveTrackedDirs() {
  const map = new Map();
  for (const d of [...config.trackedDirs, ...homepageDirs]) {
    if (!map.has(d.path)) map.set(d.path, d);
  }
  return [...map.values()];
}

let configWatchTimer = null;
try {
  fs.watch(path.dirname(CONFIG_PATH), (ev, fn) => {
    if (fn !== path.basename(CONFIG_PATH)) return;
    clearTimeout(configWatchTimer);
    configWatchTimer = setTimeout(() => {
      try { config = loadConfigSync(); reloadHomepageDirs(); applyCollectors(); log('配置热加载完成'); }
      catch (e) { log('配置热加载失败（保留旧配置）:', e.message); }
    }, 600);
  });
} catch (e) { log('fs.watch 不可用:', e.message); }

function saveConfig(patch) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const merged = { ...raw, ...patch };
  fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  config = loadConfigSync();
  reloadHomepageDirs();
  applyCollectors();
}

/* ============================ 密钥库 / 加密 ============================ */
function ensureSecret() {
  ensureDirSync(DATA_DIR);
  try {
    const k = fs.readFileSync(SECRET_PATH);
    if (k.length === 32) return k;
  } catch { /* 首次 */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_PATH, k, { mode: 0o600 });
  return k;
}
const SECRET_KEY = ensureSecret();
function encSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decSecret(blob) {
  try {
    const [iv, tag, ct] = String(blob).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}
let credentials = {};
try { credentials = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch { /* 首次 */ }
function saveCredentials() {
  ensureDirSync(DATA_DIR);
  const tmp = CREDS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDS_PATH);
}

/* ============================ 密码 / 会话 / 限速 ============================ */
function scryptHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, hash] = String(stored).split('$');
    const calc = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
  } catch { return false; }
}
function ensurePasswordHash() {
  if (config.auth && config.auth.passwordHash) return;
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let pw = '';
  const buf = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) pw += alphabet[buf[i] % alphabet.length];
  ensureDirSync(DATA_DIR);
  fs.writeFileSync(INITIAL_PW_PATH, pw + '\n', { mode: 0o600 });
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  raw.auth = { ...(raw.auth || {}), passwordHash: scryptHash(pw) };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
  config = loadConfigSync();
  log('首次启动：已生成随机初始密码 →', INITIAL_PW_PATH, '（请尽快登录后在设置中修改）');
}
ensurePasswordHash();

const sessions = new Map(); // token -> { expires, ip, created }
function createSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttlMs = (config.auth.sessionTtlHours || 12) * 3600 * 1000;
  sessions.set(token, { expires: Date.now() + ttlMs, ip, created: Date.now() });
  return token;
}
function getSession(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(m[1]); return null; }
  s.expires = Date.now() + (config.auth.sessionTtlHours || 12) * 3600 * 1000; // 滑动续期
  return m[1];
}
setInterval(() => {
  for (const [t, s] of sessions) if (Date.now() > s.expires) sessions.delete(t);
}, 60_000).unref();

const failCounter = new Map(); // ip -> {count, win}
function rateLimited(ip) {
  const now = Date.now();
  const e = failCounter.get(ip);
  if (!e || now - e.win > 60_000) { failCounter.set(ip, { count: 1, win: now }); return false; }
  e.count += 1;
  return e.count > (config.auth.maxFailPerMin || 5);
}

/* ============================ 审计 ============================ */
function audit(event, fields = {}) {
  appendJsonl(AUDIT_PATH, { ts: nowIso(), event, ...fields });
}

/* ============================ 远程采集脚本（POSIX sh + 单个 awk，只读） ============================ */
// 计数器口径输出，速率由网关差分计算；除 awk/df/grep 外零子进程（cwd/fd 用内建解析）。
// 注意：awk 段用 String.raw 保留反斜杠；shell 段含 ${...}，须用普通模板并转义为 \${。
const REMOTE_PROBE_AWK = String.raw`
awk '
BEGIN { FS = " " }
FILENAME == "/proc/stat" && $1 ~ /^cpu[0-9]*$/ { print "CPU " $0 }
FILENAME == "/proc/loadavg" { print "LOAD " $0 }
FILENAME == "/proc/uptime" { print "UP " $0 }
FILENAME == "/proc/meminfo" && $1 ~ /^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):$/ { print "MEM " $1 " " $2 }
FILENAME == "/proc/net/dev" && NF >= 16 && $1 !~ /face:/ { print "NET " $1 " " $2 " " $10 }
FILENAME == "/proc/diskstats" && $3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+)$/ { print "DIO " $3 " " $6 " " $10 }
FILENAME == "/proc/mounts" && $3 ~ /^(ext[234]|xfs|btrfs|f2fs|vfat|fuseblk|jfs|reiserfs)$/ { print "MNT " $2 }
FILENAME ~ /\/proc\/[0-9]+\/stat$/ {
  pid = FILENAME; sub(/\/proc\//, "", pid); sub(/\/stat$/, "", pid); pid = pid + 0
  raw = $0; sub(/^[0-9]+ \(/, "", raw); i = index(raw, ") ")
  if (!i) next
  split(substr(raw, i + 2), f, " ")
  ut[pid] = f[12]; st[pid] = f[13]
}
FILENAME ~ /\/proc\/[0-9]+\/status$/ {
  pid = FILENAME; sub(/\/proc\//, "", pid); sub(/\/status$/, "", pid); pid = pid + 0
  if ($1 == "VmRSS:") rss[pid] = $2
  else if ($1 == "Threads:") thr[pid] = $2
}
FILENAME ~ /\/proc\/[0-9]+\/io$/ {
  pid = FILENAME; sub(/\/proc\//, "", pid); sub(/\/io$/, "", pid); pid = pid + 0
  if ($1 == "read_bytes:") ior[pid] = $2
  else if ($1 == "write_bytes:") iow[pid] = $2
}
FILENAME ~ /\/proc\/[0-9]+\/cgroup$/ {
  if (match($0, /docker[-\/][0-9a-f]+/)) {
    pid = FILENAME; sub(/\/proc\//, "", pid); sub(/\/cgroup$/, "", pid); pid = pid + 0
    cg[pid] = substr($0, RSTART + 7, RLENGTH - 7)
  }
}
END {
  print "===PROCS==="
  for (p in ut) print "PRC " p " " (rss[p] + 0) " " (thr[p] + 0) " " (ior[p] + 0) " " (iow[p] + 0) " " ut[p] " " st[p]
}
' /proc/stat /proc/loadavg /proc/uptime /proc/meminfo /proc/net/dev /proc/diskstats /proc/mounts /proc/[0-9]*/stat /proc/[0-9]*/status /proc/[0-9]*/io /proc/[0-9]*/cgroup 2>/dev/null
`;
const REMOTE_PROBE_SHELL = `
echo "===PWD==="
# 工作目录与句柄数（纯内建，无子进程；非 root 时 fd 记 0、cwd 记空）
for d in /proc/[0-9]*; do
  pid=\${d##*/}
  cwd=$(cd "$d/cwd" 2>/dev/null && pwd -P) || cwd=""
  if [ -r "$d/fd" ]; then set -- "$d"/fd/*; nf=$#; else nf=0; fi
  echo "PWD $pid $nf $cwd"
done
echo "===DF==="
df -kPT 2>/dev/null
echo "===OS==="
grep -m2 -E '^(NAME|VERSION_ID)=' /etc/os-release 2>/dev/null
echo "===END==="
`;
const REMOTE_PROBE_SCRIPT = REMOTE_PROBE_AWK + REMOTE_PROBE_SHELL;

/* ============================ SSH 连接（采集/终端共用，TOFU 指纹校验） ============================ */
function connectSSH(creds, timeoutMs = 12_000, externalConn = null) {
  return new Promise((resolve, reject) => {
    const conn = externalConn || new SSHClient();
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; err ? reject(err) : resolve(conn); } };
    const timer = setTimeout(() => { try { conn.end(); } catch {} done(new Error('连接超时')); }, timeoutMs);
    conn.on('error', (e) => { clearTimeout(timer); done(e); });
    conn.on('ready', () => { clearTimeout(timer); done(null); });
    const opt = { host: creds.host, port: creds.port, username: creds.username, readyTimeout: timeoutMs, keepaliveInterval: 15_000 };
    opt.hostVerifier = (key) => {
      const fp = crypto.createHash('sha256').update(key).digest('base64');
      const rec = credentials[creds._hostId] || (credentials[creds._hostId] = {});
      if (!rec.hostFp) { rec.hostFp = fp; saveCredentials(); audit('host_key_accept', { host: creds.host, fp }); return true; }
      if (rec.hostFp !== fp) { clearTimeout(timer); done(new Error('目标机主机指纹变化，已拒绝连接（确认合法后删除 data/monitor/credentials.json 中该主机的 hostFp）')); return false; }
      return true;
    };
    if (creds.authType === 'password') {
      const rec = credentials[creds._hostId];
      const pw = rec && rec.password ? decSecret(rec.password) : null;
      if (!pw) { done(new Error('未配置密码凭据（CLI --set-cred 或看板设置）')); return; }
      opt.password = pw;
    } else {
      if (!creds.keyPath || !fs.existsSync(creds.keyPath)) { done(new Error('未配置 SSH 私钥或文件不存在: ' + (creds.keyPath || '(空)'))); return; }
      try { opt.privateKey = fs.readFileSync(creds.keyPath, 'utf8'); } catch (e) { done(new Error('读取私钥失败: ' + e.message)); return; }
    }
    conn.connect(opt);
  });
}
function getConnCreds(host) {
  if (host.type === 'local') {
    const t = host.terminal || {};
    return { host: t.host || '127.0.0.1', port: t.port || 22, username: t.username || 'root', authType: t.authType || 'key', keyPath: t.keyPath || '', _hostId: host.id };
  }
  return { host: host.address, port: host.port || 22, username: host.username || 'root', authType: host.authType || 'key', keyPath: host.keyPath || '', _hostId: host.id };
}
async function sshProbe(host) {
  const creds = getConnCreds(host);
  const conn = await connectSSH(creds, 12_000);
  try {
    const stdout = await new Promise((resolve, reject) => {
      conn.exec('sh -s', (err, stream) => {
        if (err) return reject(err);
        let out = '';
        const t = setTimeout(() => reject(new Error('探测超时')), 15_000);
        stream.on('data', (d) => { out += d.toString(); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => { clearTimeout(t); resolve(out); });
        stream.write(REMOTE_PROBE_SCRIPT);
        stream.end();
      });
    });
    return parseRemoteOutput(stdout);
  } finally { try { conn.end(); } catch {} }
}

/* ============================ 远程输出解析 → 计数器 ============================ */
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'vfat', 'fuseblk', 'jfs', 'reiserfs']);
function parseRemoteOutput(text) {
  const c = { cpuLines: [], load: null, up: null, mem: {}, net: {}, dio: {}, mnts: [], procs: new Map(), df: [], osName: '' };
  let section = 'MAIN';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '===PROCS===') { section = 'PROCS'; continue; }
    if (t === '===PWD===') { section = 'PWD'; continue; }
    if (t === '===DF===') { section = 'DF'; continue; }
    if (t === '===OS===') { section = 'OS'; continue; }
    if (t === '===END===' || t === '') continue;
    if (section === 'MAIN') {
      const f = t.split(/\s+/);
      if (f[0] === 'CPU') c.cpuLines.push(f.slice(1).map(Number));
      else if (f[0] === 'LOAD') c.load = [Number(f[1]), Number(f[2]), Number(f[3])];
      else if (f[0] === 'UP') c.up = Number(f[1]);
      else if (f[0] === 'MEM') c.mem[f[1].replace(':', '')] = Number(f[2]);
      else if (f[0] === 'NET') c.net[f[1].replace(':', '')] = { rb: +f[2] || 0, sb: +f[3] || 0 };
      else if (f[0] === 'DIO') c.dio[f[1]] = { rs: +f[2] || 0, ws: +f[3] || 0 };
      else if (f[0] === 'MNT') c.mnts.push(f.slice(1).join(' '));
    } else if (section === 'PROCS') {
      const f = t.split(/\s+/);
      if (f[0] === 'PRC') c.procs.set(+f[1], { rssKb: +f[2] || 0, threads: +f[3] || 0, ioR: +f[4] || 0, ioW: +f[5] || 0, ut: +f[6] || 0, st: +f[7] || 0, cwd: '', exe: '', cmd: '', comm: '', fds: 0, cg: '' });
    } else if (section === 'PWD') {
      // 行格式：PWD <pid> <fds> <cwd...>（cwd 可含空格，取第四个空格之后）
      if (!t.startsWith('PWD ')) continue;
      const rest = t.slice(4);
      const sp1 = rest.indexOf(' ');
      const sp2 = rest.indexOf(' ', sp1 + 1);
      if (sp1 < 0 || sp2 < 0) continue;
      const pid = +rest.slice(0, sp1);
      const p = c.procs.get(pid);
      if (p) { p.fds = +rest.slice(sp1 + 1, sp2) || 0; p.cwd = rest.slice(sp2 + 1); }
    } else if (section === 'DF') {
      const f = t.split(/\s+/);
      if (f[0] === 'Filesystem' || f.length < 6) continue;
      if (!REAL_FS.has(f[1])) continue;
      c.df.push({ fs: f[0], type: f[1], totalKb: +f[2] || 0, usedKb: +f[3] || 0, mnt: f.slice(5).join(' ') });
    } else if (section === 'OS') {
      const kv = t.split('=', 2);
      if (kv[0] === 'NAME' && kv[1]) c.osName = kv[1].replace(/"/g, '');
    }
  }
  // 同一设备多次挂载（bind）去重：保留最上层（首次出现）挂载点
  const seenFs = new Set();
  c.df = c.df.filter(d => (seenFs.has(d.fs) ? false : (seenFs.add(d.fs), true)));
  return c;
}

/* ============================ 本机采集（直读 /proc，零子进程） ============================ */
function readLocalCounters() {
  const c = { cpuLines: [], load: null, up: null, mem: {}, net: {}, dio: {}, mnts: [], procs: new Map(), df: [], osName: '' };
  try {
    for (const line of fs.readFileSync('/proc/stat', 'utf8').split('\n')) {
      if (/^cpu[0-9]*\s/.test(line)) c.cpuLines.push(line.trim().split(/\s+/).slice(1).map(Number));
    }
    const la = fs.readFileSync('/proc/loadavg', 'utf8').split(/\s+/);
    c.load = [Number(la[0]), Number(la[1]), Number(la[2])];
    c.up = Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
    for (const m of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const mm = /^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):\s+(\d+)/.exec(m);
      if (mm) c.mem[mm[1]] = Number(mm[2]);
    }
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const seg = line.trim().split(':');
      if (seg.length < 2) continue;
      const f = (seg[1] || '').trim().split(/\s+/);
      c.net[seg[0].trim()] = { rb: +f[0] || 0, sb: +f[8] || 0 };
    }
    for (const line of fs.readFileSync('/proc/diskstats', 'utf8').split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length > 10 && /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+)$/.test(f[2])) c.dio[f[2]] = { rs: +f[5] || 0, ws: +f[9] || 0 };
    }
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const f = line.split(/\s+/);
      if (f.length >= 3 && REAL_FS.has(f[2])) c.mnts.push(f[1]);
    }
    c.osName = `${os.type()} ${os.release()} · ${os.cpus()[0] ? os.cpus()[0].model.trim() : ''}`;
  } catch (e) { log('本机 /proc 读取异常:', e.message); }

  // 磁盘用量（statfs；跳过已有挂载点的子路径 = 同一文件系统的 bind/子目录）
  const added = [];
  for (const mnt of [...new Set(c.mnts)].sort((a, b) => a.length - b.length)) {
    if (added.some(s => mnt.startsWith(s.endsWith('/') ? s : s + '/'))) continue;
    try {
      const st = fs.statfsSync(mnt);
      added.push(mnt);
      c.df.push({ fs: mnt, type: 'statfs', totalKb: (st.blocks * st.bsize) / 1024, usedKb: ((st.blocks - st.bavail) * st.bsize) / 1024, mnt });
    } catch { /* 忽略 */ }
  }

  // 进程枚举（归属所需的 cwd/exe/cmd/status/io；fd 仅对命中目录的进程计数）
  const dirs = effectiveTrackedDirs();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = +name;
    const base = `/proc/${pid}`;
    try {
      let cwd = '', exe = '', cmd = '';
      try { cwd = fs.readlinkSync(`${base}/cwd`); } catch {}
      try { exe = fs.readlinkSync(`${base}/exe`); } catch {}
      try { cmd = fs.readFileSync(`${base}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().slice(0, 200); } catch {}
      const statRaw = fs.readFileSync(`${base}/stat`, 'utf8');
      const m = statRaw.match(/^\d+ \((.*)\)\s(.*)$/s);
      if (!m) continue;
      const rest = m[2].split(/\s+/); // rest[0]=state, rest[1]=ppid, utime=rest[11], stime=rest[12]
      let rssKb = 0, threads = 1, ioR = 0, ioW = 0, cg = '';
      try {
        const stTxt = fs.readFileSync(`${base}/status`, 'utf8');
        rssKb = Number(/VmRSS:\s+(\d+)/.exec(stTxt)?.[1] || 0);
        threads = Number(/Threads:\s+(\d+)/.exec(stTxt)?.[1] || 1);
      } catch {}
      try {
        const ioTxt = fs.readFileSync(`${base}/io`, 'utf8');
        ioR = Number(/read_bytes:\s+(\d+)/.exec(ioTxt)?.[1] || 0);
        ioW = Number(/write_bytes:\s+(\d+)/.exec(ioTxt)?.[1] || 0);
      } catch {}
      c.procs.set(pid, { cwd, exe, cmd, comm: m[1].slice(0, 40), ppid: +rest[1] || 0, state: rest[0], rssKb, threads, ioR, ioW, ut: +rest[11] || 0, st: +rest[12] || 0, fds: 0, cg: '', _dir: matchDirOf({ cwd, exe, cmd }, dirs)?.path || '' });
    } catch { /* 进程已退出 */ }
  }
  // 未命中目录的进程读 cgroup 做容器归属（compose 目录命中则并入目录组）
  const dirMap = new Map(dirs.map(d => [d.path, d]));
  for (const [pid, p] of c.procs) {
    if (p._dir) continue;
    try {
      const cgTxt = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
      const mm = /docker[-/]([0-9a-f]{12,64})/.exec(cgTxt);
      if (!mm) continue;
      p.cg = mm[1];
      const info = dockerMap.get(mm[1].slice(0, 12));
      if (info?.dir && dirMap.has(info.dir)) p._dir = info.dir;
    } catch {}
  }
  // 句柄数：仅对命中目录/容器的进程统计（readdir fd），避免全量扫 fd 目录
  for (const [pid, p] of c.procs) {
    if (!p._dir && !p.cg) continue;
    try { p.fds = fs.readdirSync(`/proc/${pid}/fd`).length; } catch {}
  }
  return c;
}

function matchDirOf(p, dirs) {
  for (const d of dirs) {
    const pt = d.path;
    if (p.cwd === pt || (p.cwd && p.cwd.startsWith(pt + '/'))) return d;
    if (p.exe === pt || (p.exe && p.exe.startsWith(pt + '/'))) return d;
    if (p.cmd && p.cmd.includes(pt + '/')) return d;
  }
  return null;
}

/* ============================ docker 容器映射（本机） ============================ */
let dockerMap = new Map(); // 容器ID(12) -> {name, image, dir}
function refreshDockerMap() {
  execFile('docker', ['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Labels}}'], { timeout: 8_000 }, (err, stdout) => {
    if (err) { dockerMap = new Map(); return; }
    const m = new Map();
    for (const line of stdout.trim().split('\n')) {
      const [id, names, image, labels] = line.split('\t');
      if (!id) continue;
      let dir = '';
      for (const kv of String(labels || '').split(',')) {
        const eq = kv.indexOf('=');
        if (eq > 0 && kv.slice(0, eq) === 'com.docker.compose.project.working_dir') { dir = kv.slice(eq + 1); break; }
      }
      m.set(id.slice(0, 12), { name: names, image, dir });
    }
    dockerMap = m;
  });
}

/* ============================ 计数器 → 快照（含目录聚合） ============================ */
function cpuFromLines(lines, prevLines) {
  if (!prevLines || prevLines.length !== lines.length) return { pct: null, total: 0, perCore: [] };
  const perCore = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i], pre = prevLines[i];
    const idle = (cur[3] || 0) + (cur[4] || 0), pidle = (pre[3] || 0) + (pre[4] || 0);
    const t = cur.slice(0, 8).reduce((a, b) => a + (b || 0), 0) - pre.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    const dI = idle - pidle;
    if (i === 0) { total = t; continue; }
    perCore.push(t > CPU_DELTA_MIN ? Math.min(100, Math.max(0, (1 - dI / t) * 100)) : null);
  }
  const pct = total > CPU_DELTA_MIN ? Math.min(100, Math.max(0, (1 - ((lines[0][3] + lines[0][4]) - (prevLines[0][3] + prevLines[0][4])) / total) * 100)) : null;
  return { pct, total, perCore };
}

function buildSnapshot(hostId, counters, prev, intervalSec, isFirst) {
  const dirsCfg = effectiveTrackedDirs();
  const dirMap = new Map(dirsCfg.map(d => [d.path, d]));
  const coreN = Math.max(1, counters.cpuLines.length - 1);
  const cpu = cpuFromLines(counters.cpuLines, prev?.cpuLines);

  // 主网卡：排除虚拟口后取累计字节最大者（近似默认路由网卡）
  let primary = '';
  let maxBytes = -1;
  for (const [name, n] of Object.entries(counters.net)) {
    if (/^(lo|docker0|br-|veth|tun|tap)/.test(name)) continue;
    if (n.rb + n.sb > maxBytes) { maxBytes = n.rb + n.sb; primary = name; }
  }

  // 进程差分 + 目录/容器归属聚合
  const dirAgg = new Map();
  const matchedProcs = [];
  for (const [pid, p] of counters.procs) {
    let dCpu = 0, dIoR = 0, dIoW = 0;
    const pre = prev?.procs?.get(pid);
    if (pre && !isFirst) {
      dCpu = Math.max(0, (p.ut - pre.ut) + (p.st - pre.st));
      dIoR = Math.max(0, p.ioR - pre.ioR);
      dIoW = Math.max(0, p.ioW - pre.ioW);
    }
    const cpuPct = cpu.total > CPU_DELTA_MIN ? (dCpu / cpu.total) * 100 : null;
    let groupName = null, groupPath = null, groupSource = null;
    if (p._dir && dirMap.has(p._dir)) {
      const dc = dirMap.get(p._dir);
      groupName = dc.name; groupPath = dc.path; groupSource = dc.source;
    } else if (p.cg) {
      const info = dockerMap.get(p.cg.slice(0, 12));
      const dc = info?.dir ? dirMap.get(info.dir) : null;
      if (dc) { groupName = dc.name; groupPath = dc.path; groupSource = dc.source; p._dir = dc.path; }
      else { groupName = `容器 ${info?.name || p.cg.slice(0, 8)}`; groupPath = `docker:${info?.name || p.cg.slice(0, 12)}`; groupSource = 'container'; }
    } else {
      continue; // 未命中跟踪目录 → 不入库（不越界采集）
    }
    const rec = {
      pid,
      name: (p.exe && path.basename(p.exe)) || (p.cmd && path.basename(p.cmd.split(/\s+/)[0])) || (p.cwd && path.basename(p.cwd)) || p.comm || `pid ${pid}`,
      cmd: p.cmd || p.comm || '',
      cwd: p.cwd || '', dir: groupPath, dirName: groupName,
      container: p.cg ? (dockerMap.get(p.cg.slice(0, 12))?.name || p.cg.slice(0, 8)) : '',
      cpuPct: cpuPct == null ? null : +cpuPct.toFixed(2),
      memMb: +(p.rssKb / 1024).toFixed(1),
      threads: p.threads, fds: p.fds || 0,
      ioReadMbs: intervalSec > 0 ? +(dIoR / intervalSec / 1048576).toFixed(3) : null,
      ioWriteMbs: intervalSec > 0 ? +(dIoW / intervalSec / 1048576).toFixed(3) : null,
    };
    matchedProcs.push(rec);
    let g = dirAgg.get(groupPath);
    if (!g) { g = { path: groupPath, name: groupName, source: groupSource, procs: 0, cpuPct: 0, memMb: 0, ioReadMbs: 0, ioWriteMbs: 0, threads: 0, fds: 0, top: [] }; dirAgg.set(groupPath, g); }
    g.procs += 1; g.cpuPct += cpuPct || 0; g.memMb += rec.memMb;
    g.ioReadMbs += rec.ioReadMbs || 0; g.ioWriteMbs += rec.ioWriteMbs || 0;
    g.threads += rec.threads; g.fds += rec.fds;
    g.top.push(rec);
  }

  // 网络速率（Mbps）
  let netIn = null, netOut = null, netTotalIn = null, netTotalOut = null;
  if (prev?.net && !isFirst && intervalSec > 0) {
    if (primary && prev.net[primary]) {
      netIn = +(Math.max(0, counters.net[primary].rb - prev.net[primary].rb) / intervalSec * 8 / 1e6).toFixed(3);
      netOut = +(Math.max(0, counters.net[primary].sb - prev.net[primary].sb) / intervalSec * 8 / 1e6).toFixed(3);
    }
    let ti = 0, to = 0;
    for (const [name, n] of Object.entries(counters.net)) {
      const pv = prev.net[name];
      if (pv && name !== 'lo') { ti += Math.max(0, n.rb - pv.rb); to += Math.max(0, n.sb - pv.sb); }
    }
    netTotalIn = +(ti / intervalSec * 8 / 1e6).toFixed(3);
    netTotalOut = +(to / intervalSec * 8 / 1e6).toFixed(3);
  }

  // 磁盘 IO（MB/s，扇区×512）
  let dioR = null, dioW = null;
  if (prev?.dio && !isFirst && intervalSec > 0) {
    let r = 0, w = 0;
    for (const [dev, v] of Object.entries(counters.dio)) {
      const pv = prev.dio[dev];
      if (pv) { r += Math.max(0, v.rs - pv.rs); w += Math.max(0, v.ws - pv.ws); }
    }
    dioR = +(r * 512 / intervalSec / 1048576).toFixed(3);
    dioW = +(w * 512 / intervalSec / 1048576).toFixed(3);
  }

  const memTotal = counters.mem.MemTotal || 0;
  const memAvail = counters.mem.MemAvailable ?? counters.mem.MemFree ?? 0;
  const memPct = memTotal ? +Math.min(100, ((memTotal - memAvail) / memTotal) * 100).toFixed(1) : null;
  const swapPct = counters.mem.SwapTotal ? +( (1 - (counters.mem.SwapFree || 0) / counters.mem.SwapTotal) * 100).toFixed(1) : 0;

  const snap = {
    hostId, t: Date.now(), online: true,
    os: counters.osName || '', uptimeSec: Math.round(counters.up || 0),
    cpu: { pct: cpu.pct == null ? null : +cpu.pct.toFixed(1), cores: coreN, perCore: cpu.perCore.map(x => x == null ? null : +x.toFixed(1)), load1: counters.load?.[0] ?? null, load5: counters.load?.[1] ?? null, load15: counters.load?.[2] ?? null, loadPerCore: counters.load ? +(counters.load[0] / coreN).toFixed(2) : null },
    mem: { totalMb: Math.round(memTotal / 1024), usedMb: memTotal ? Math.round((memTotal - memAvail) / 1024) : null, pct: memPct, swapPct },
    disks: counters.df.map(d => ({ mnt: d.mnt, type: d.type, totalGb: +(d.totalKb / 1048576).toFixed(1), usedGb: +(d.usedKb / 1048576).toFixed(1), pct: d.totalKb ? +(d.usedKb / d.totalKb * 100).toFixed(1) : null })),
    diskIo: { readMbs: dioR, writeMbs: dioW },
    net: { iface: primary, inMbs: netIn, outMbs: netOut, totalInMbs: netTotalIn, totalOutMbs: netTotalOut },
    procsCount: counters.procs.size,
    containersCount: new Set([...counters.procs.values()].map(p => p.cg).filter(Boolean)).size,
    dirs: [...dirAgg.values()].map(g => ({
      ...g,
      cpuPct: +g.cpuPct.toFixed(2), memMb: +g.memMb.toFixed(1),
      ioReadMbs: +g.ioReadMbs.toFixed(3), ioWriteMbs: +g.ioWriteMbs.toFixed(3),
      top: g.top.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0)).slice(0, 8),
    })),
    error: '',
  };
  const detail = { procs: matchedProcs, dirs: snap.dirs, procsTotal: counters.procs.size };
  const prevNext = { cpuLines: counters.cpuLines, net: counters.net, dio: counters.dio, procs: counters.procs };
  return { snap, prev: prevNext, detail };
}

/* ============================ 历史存储（内存环形 + JSONL 分钟降采样） ============================ */
const RAW_CAP = 720;      // 5s × 1h
const MINUTE_CAP = 1440;  // 1min × 24h
const history = new Map(); // hostId -> { raw: [], minute: [], loaded }
function histOf(hostId) {
  if (!history.has(hostId)) history.set(hostId, { raw: [], minute: [], loaded: false, lastMinuteTs: 0 });
  return history.get(hostId);
}
function compactPoint(snap) {
  const dirs = {};
  for (const d of snap.dirs || []) dirs[d.path] = { cpu: d.cpuPct, mem: d.memMb, ioR: d.ioReadMbs, ioW: d.ioWriteMbs, thr: d.threads, fds: d.fds, procs: d.procs };
  return { t: snap.t, cpu: snap.cpu.pct, load: snap.cpu.load1, loadN: snap.cpu.loadPerCore, mem: snap.mem.pct, swap: snap.mem.swapPct, disks: snap.disks, dioR: snap.diskIo.readMbs, dioW: snap.diskIo.writeMbs, netI: snap.net.inMbs, netO: snap.net.outMbs, dirs };
}
function pushHistory(hostId, snap) {
  const h = histOf(hostId);
  h.raw.push(compactPoint(snap));
  if (h.raw.length > RAW_CAP) h.raw.shift();
  const minuteTs = Math.floor(snap.t / 60_000) * 60_000;
  if (h.lastMinuteTs && minuteTs !== h.lastMinuteTs) {
    const window = h.raw.filter(p => p.t >= h.lastMinuteTs && p.t < minuteTs);
    if (window.length) {
      const avg = avgPoints(window, h.lastMinuteTs);
      h.minute.push(avg);
      if (h.minute.length > MINUTE_CAP) h.minute.shift();
      appendJsonl(path.join(HISTORY_DIR, hostId, `${new Date(h.lastMinuteTs).toISOString().slice(0, 10)}.jsonl`), avg);
    }
  }
  h.lastMinuteTs = minuteTs;
}
function pushHistoryOffline(hostId, t) {
  const h = histOf(hostId);
  h.raw.push({ t, cpu: null, load: null, loadN: null, mem: null, swap: null, disks: [], dioR: null, dioW: null, netI: null, netO: null, dirs: {}, offline: true });
  if (h.raw.length > RAW_CAP) h.raw.shift();
}
function avgPoints(window, t) {
  const out = { t, dirs: {} };
  for (const k of ['cpu', 'load', 'loadN', 'mem', 'swap', 'dioR', 'dioW', 'netI', 'netO']) {
    const vals = window.map(p => p[k]).filter(v => v != null && Number.isFinite(v));
    out[k] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3) : null;
  }
  for (const k of ['dioR', 'dioW', 'netI', 'netO']) {
    const vals = window.map(p => p[k]).filter(v => v != null);
    if (vals.length) out[k + '_peak'] = +Math.max(...vals).toFixed(3);
  }
  const dirKeys = new Set();
  window.forEach(p => Object.keys(p.dirs || {}).forEach(k => dirKeys.add(k)));
  for (const k of dirKeys) {
    const rows = window.map(p => p.dirs[k]).filter(Boolean);
    if (!rows.length) continue;
    const avg = (key) => { const v = rows.map(r => r[key]).filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null; };
    const peak = (key) => { const v = rows.map(r => r[key]).filter(x => x != null); return v.length ? +Math.max(...v).toFixed(3) : null; };
    out.dirs[k] = { cpu: avg('cpu'), mem: avg('mem'), ioR: avg('ioR'), ioW: avg('ioW'), thr: avg('thr'), fds: avg('fds'), procs: Math.max(...rows.map(r => r.procs || 0)), ioR_peak: peak('ioR') };
  }
  out.disks = window[window.length - 1]?.disks || [];
  return out;
}
function loadHistoryFromDisk(hostId) {
  const h = histOf(hostId);
  if (h.loaded) return;
  h.loaded = true;
  for (const off of [1, 0]) {
    const d = new Date(Date.now() - off * 86_400_000);
    try {
      const txt = fs.readFileSync(path.join(HISTORY_DIR, hostId, `${d.toISOString().slice(0, 10)}.jsonl`), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try { h.minute.push(JSON.parse(line)); } catch {}
      }
    } catch {}
  }
  h.minute.sort((a, b) => a.t - b.t);
  if (h.minute.length > MINUTE_CAP) h.minute.splice(0, h.minute.length - MINUTE_CAP);
  if (h.minute.length) h.lastMinuteTs = h.minute[h.minute.length - 1].t;
}
function cleanHistoryRetention() {
  const cutoff = Date.now() - (config.collect.retentionDays || 7) * 86_400_000;
  for (const hostId of history.keys()) {
    const dir = path.join(HISTORY_DIR, hostId);
    fs.readdir(dir, (err, files) => {
      if (err) return;
      for (const f of files) {
        const ts = Date.parse(f.replace('.jsonl', 'T00:00:00Z'));
        if (Number.isFinite(ts) && ts < cutoff) fs.unlink(path.join(dir, f), () => {});
      }
    });
  }
}

/* ============================ 告警引擎 ============================ */
const alertState = new Map(); // key -> {since, active, level, activeTs, value}
function evalAlerts(hostId, snap) {
  const th = config.thresholds;
  const sustainMs = (th.sustainMin || 3) * 60_000;
  const checks = [
    { metric: 'cpu', value: snap.cpu?.pct, th: th.cpuPct, label: `CPU ${snap.cpu?.pct?.toFixed(0)}%` },
    { metric: 'mem', value: snap.mem?.pct, th: th.memPct, label: `内存 ${snap.mem?.pct?.toFixed(0)}%` },
    { metric: 'load', value: snap.cpu?.loadPerCore, th: th.loadPerCore, label: `负载 ${snap.cpu?.loadPerCore?.toFixed(2)}/核` },
    ...(snap.disks || []).filter(d => d.pct != null).map(d => ({ metric: `disk:${d.mnt}`, value: d.pct, th: th.diskPct, label: `磁盘 ${d.mnt} ${d.pct?.toFixed(0)}%` })),
  ];
  const activeNow = [];
  for (const c of checks) {
    if (c.value == null || c.th == null) continue;
    const key = `${hostId}:${c.metric}`;
    let st = alertState.get(key);
    if (c.value >= c.th) {
      if (!st) { st = { since: snap.t, active: false, level: 'warn', activeTs: 0, value: c.value }; alertState.set(key, st); }
      st.value = c.value;
      st.level = (c.value >= c.th + 10 || c.value >= 95) ? 'crit' : 'warn';
      if (!st.active && snap.t - st.since >= sustainMs) {
        st.active = true; st.activeTs = snap.t;
        const payload = { id: key, hostId, metric: c.metric, label: c.label, value: +c.value.toFixed(1), threshold: c.th, level: st.level, activeTs: new Date(st.activeTs).toISOString(), state: 'active' };
        appendJsonl(ALERTS_PATH, { ts: nowIso(), event: 'alert_active', ...payload });
        notifyWebhook({ event: 'alert_active', ...payload });
      }
      if (st.active) activeNow.push({ id: key, hostId, metric: c.metric, label: c.label, value: +c.value.toFixed(1), threshold: c.th, level: st.level, activeTs: new Date(st.activeTs).toISOString(), state: 'active' });
    } else if (st) {
      if (st.active) {
        const payload = { id: key, hostId, metric: c.metric, label: c.label, value: +c.value.toFixed(1), threshold: c.th, level: st.level, activeTs: new Date(st.activeTs).toISOString(), resolvedTs: nowIso(), state: 'resolved' };
        appendJsonl(ALERTS_PATH, { ts: nowIso(), event: 'alert_resolve', ...payload });
        notifyWebhook({ event: 'alert_resolve', ...payload });
      }
      alertState.delete(key);
    }
  }
  snap.alerts = activeNow;
}
async function notifyWebhook(payload) {
  const url = config.webhookUrl;
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) }); }
  catch (e) { log('webhook 通知失败:', e.message); }
}

/* ============================ 采集调度 ============================ */
const hostState = new Map(); // hostId -> {prev, lastSnap, online, error, lastOk, probing}
const procDetailCache = new Map(); // hostId -> {procs, dirs, procsTotal}
function stateOf(id) {
  if (!hostState.has(id)) hostState.set(id, { prev: null, lastSnap: null, online: false, error: '尚未探测', lastOk: 0, probing: false });
  return hostState.get(id);
}
function finishTick(host, snap, detail) {
  const st = stateOf(host.id);
  st.online = true; st.error = ''; st.lastOk = Date.now();
  st.lastSnap = snap;
  procDetailCache.set(host.id, detail);
  pushHistory(host.id, snap);
  evalAlerts(host.id, snap);
}

async function tickLocal(host) {
  const st = stateOf(host.id);
  if (st.probing) return;
  st.probing = true;
  const t0 = Date.now();
  try {
    const counters = readLocalCounters();
    const interval = st.prev ? Math.max(0.5, (t0 - (st.prev.t || t0)) / 1000) : 0;
    const { snap, prev, detail } = buildSnapshot(host.id, counters, st.prev, interval, !st.prev);
    prev.t = t0;
    st.prev = prev;
    finishTick(host, snap, detail);
  } catch (e) {
    st.online = false; st.error = e.message;
    log(`本机采集失败:`, e.message);
  } finally { st.probing = false; }
}

async function tickRemote(host) {
  const st = stateOf(host.id);
  if (st.probing) return;
  st.probing = true;
  const t0 = Date.now();
  try {
    const counters = await sshProbe(host);
    const interval = st.prev ? Math.max(0.5, (t0 - (st.prev.t || t0)) / 1000) : 0;
    const { snap, prev, detail } = buildSnapshot(host.id, counters, st.prev, interval, !st.prev);
    prev.t = t0;
    st.prev = prev;
    finishTick(host, snap, detail);
  } catch (e) {
    st.online = false; st.error = String(e.message || e);
    st.lastSnap = { hostId: host.id, t: Date.now(), online: false, os: st.lastSnap?.os || '', uptimeSec: st.lastSnap?.uptimeSec || 0, cpu: null, mem: null, disks: [], diskIo: {}, net: {}, procsCount: 0, containersCount: 0, dirs: [], alerts: [], error: st.error };
    pushHistoryOffline(host.id, Date.now());
  } finally { st.probing = false; }
}

let collectorTimers = [];
function applyCollectors() {
  for (const t of collectorTimers) clearInterval(t);
  collectorTimers = [];
  for (const host of config.hosts) {
    loadHistoryFromDisk(host.id);
    if (host.type === 'local') {
      collectorTimers.push(setInterval(() => tickLocal(host).catch(() => {}), (config.collect.localIntervalSec || 5) * 1000));
      setTimeout(() => tickLocal(host).catch(() => {}), 200);
    } else {
      collectorTimers.push(setInterval(() => tickRemote(host).catch(() => {}), (config.collect.remoteIntervalSec || 20) * 1000));
      setTimeout(() => tickRemote(host).catch(() => {}), 800 + Math.floor(Math.random() * 3000));
    }
  }
}

/* ============================ 终端网关（WS + ssh2 shell） ============================ */
const wss = new WebSocketServer({ noServer: true });
const termSessions = new Map(); // hostId -> count
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（仍需会话 Cookie）
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function handleUpgrade(req, socket, head) {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { socket.destroy(); return; }
  if (pathname !== '/api/terminal') { socket.destroy(); return; }
  const token = getSession(req);
  if (!token || !originOk(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    audit('terminal_denied', { ip: req.socket.remoteAddress, reason: token ? 'origin' : 'auth' });
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => setupTerminal(ws, req));
}

function setupTerminal(ws, req) {
  const q = new URL(req.url, 'http://x').searchParams;
  const hostId = q.get('host') || '';
  const host = config.hosts.find(h => h.id === hostId);
  const ip = req.socket.remoteAddress;
  if (!host) { ws.close(4004, '主机不存在'); return; }
  const termCfg = config.terminal;
  if ((termSessions.get(hostId) || 0) >= (termCfg.maxSessionsPerHost || 2)) {
    ws.close(4029, '该主机并发会话已达上限');
    audit('terminal_denied', { host: hostId, reason: 'concurrency' });
    return;
  }

  const creds = getConnCreds(host);
  const openedAt = Date.now();
  const sessId = crypto.randomBytes(8).toString('hex');
  let cmdBuf = '';
  const cmds = [];
  let counted = false, closed = false, shellStream = null;
  ws.idleTs = Date.now();

  const cleanup = (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer); clearTimeout(maxTimer);
    if (counted) termSessions.set(hostId, Math.max(0, (termSessions.get(hostId) || 1) - 1));
    try { conn.end(); } catch {}
    audit('session_close', { sid: sessId, host: hostId, user: creds.username, ip, durationSec: Math.round((Date.now() - openedAt) / 1000), reason, commands: termCfg.recordCommands ? cmds.slice(-500) : undefined });
  };
  const idleTimer = setInterval(() => { if (Date.now() - ws.idleTs > (termCfg.idleTimeoutMin || 15) * 60_000) { try { ws.close(4001, '空闲超时'); } catch {} } }, 30_000);
  const maxTimer = setTimeout(() => { try { ws.close(4002, '会话时长达到上限'); } catch {} }, (termCfg.maxSessionMin || 240) * 60_000);

  ws.on('message', (data) => {
    ws.idleTs = Date.now();
    if (!shellStream) return;
    const buf = Buffer.from(data);
    if (buf.length > 0 && buf[0] === 0x7b) {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (msg.type === 'resize' && shellStream) { shellStream.setWindow(+msg.rows || 30, +msg.cols || 120, 0, 0); return; }
      } catch { /* 普通键盘输入（以 { 开头） */ }
    }
    if (termCfg.recordCommands) {
      cmdBuf += buf.toString('utf8');
      const parts = cmdBuf.split(/[\r\n]/);
      cmdBuf = parts.pop();
      for (const line of parts) {
        const clean = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, '').trim();
        if (clean) cmds.push(clean.slice(0, 200));
      }
    }
    shellStream.write(buf);
  });
  ws.on('close', () => cleanup('client_close'));
  ws.on('error', () => cleanup('ws_error'));

  const conn = new SSHClient();
  conn.on('error', (e) => {
    if (closed) return;
    try { ws.send(JSON.stringify({ type: 'error', message: String(e.message || e) })); ws.close(4500, 'SSH 错误'); } catch {}
  });
  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: +q.get('cols') || 120, rows: +q.get('rows') || 30 }, (err, stream) => {
      if (err) { try { ws.close(4500, '无法打开 shell'); } catch {} cleanup('shell_fail'); return; }
      shellStream = stream;
      counted = true;
      termSessions.set(hostId, (termSessions.get(hostId) || 0) + 1);
      audit('session_open', { sid: sessId, host: hostId, user: creds.username, ip });
      stream.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => { try { ws.close(4000, 'ssh_channel_closed'); } catch {} cleanup('ssh_close'); });
    });
  });
  connectSSH(creds, 15_000, conn).catch((e) => {
    if (!closed) {
      try { ws.send(JSON.stringify({ type: 'error', message: String(e.message || e) })); ws.close(4500, 'SSH 连接失败'); } catch {}
      cleanup('ssh_connect_fail');
    }
  });
}

/* ============================ HTTP 路由 ============================ */
function sendJson(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function guard(req, res) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    sendJson(res, 403, { error: 'missing X-Requested-With' });
    return false;
  }
  return true;
}
function hostCredReady(h) {
  const c = getConnCreds(h);
  if (c.authType === 'key') return !!(c.keyPath && fs.existsSync(c.keyPath));
  return !!(credentials[h.id] && credentials[h.id].password);
}
function summaryPayload() {
  const hosts = config.hosts.map((h) => {
    const st = stateOf(h.id);
    return {
      id: h.id, name: h.name, type: h.type, group: h.group, address: h.address,
      online: st.online, error: st.error,
      lastOk: st.lastOk ? new Date(st.lastOk).toISOString() : null,
      credReady: hostCredReady(h),
      snap: st.lastSnap,
    };
  });
  const alerts = [];
  for (const h of hosts) for (const a of h.snap?.alerts || []) alerts.push(a);
  return { serverTime: nowIso(), hosts, alerts };
}
function readJsonlTail(file, limit) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-limit)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = req.socket.remoteAddress;

  if (p === '/api/monitor/healthz') return sendJson(res, 200, { ok: true, t: nowIso() });

  if (p === '/api/monitor/login' && req.method === 'POST') {
    if (rateLimited(ip)) { audit('auth_fail', { ip, reason: 'rate_limited' }); return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' }); }
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!verifyPassword(body.password || '', config.auth.passwordHash)) { audit('auth_fail', { ip }); return sendJson(res, 401, { error: '密码错误' }); }
    const token = createSession(ip);
    audit('auth_ok', { ip });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${(config.auth.sessionTtlHours || 12) * 3600}` });
  }
  if (p === '/api/monitor/logout' && req.method === 'POST') {
    const token = getSession(req);
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  // —— 以下全部要求会话 ——
  if (!getSession(req)) return sendJson(res, 401, { error: '未登录或会话已过期' });

  if (p === '/api/monitor/summary' && req.method === 'GET') return sendJson(res, 200, summaryPayload());

  if (p === '/api/monitor/password' && req.method === 'POST') {
    if (!guard(req, res)) return;
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!verifyPassword(body.oldPassword || '', config.auth.passwordHash)) return sendJson(res, 401, { error: '旧密码错误' });
    if (!body.newPassword || String(body.newPassword).length < 8) return sendJson(res, 400, { error: '新密码至少 8 位' });
    saveConfig({ auth: { ...config.auth, passwordHash: scryptHash(body.newPassword) } });
    sessions.clear(); // 改密后全部会话失效
    audit('password_change', { ip });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/monitor/config' && req.method === 'GET') {
    const { auth, ...rest } = config;
    return sendJson(res, 200, { ...rest, hasPassword: !!auth?.passwordHash });
  }
  if (p === '/api/monitor/config' && req.method === 'PUT') {
    if (!guard(req, res)) return;
    const body = JSON.parse((await readBody(req)) || '{}');
    const patch = {};
    if (body.hosts !== undefined) {
      if (!Array.isArray(body.hosts)) return sendJson(res, 400, { error: 'hosts 必须是数组' });
      const norm = body.hosts.map(normalizeHost).filter(Boolean);
      const ids = new Set(norm.map(h => h.id));
      if (ids.size !== norm.length) return sendJson(res, 400, { error: '主机 id 重复' });
      for (const h of norm) if (h.type === 'ssh' && !h.address) return sendJson(res, 400, { error: `主机 ${h.id} 缺少 address` });
      patch.hosts = norm;
    }
    if (body.trackedDirs !== undefined) {
      if (!Array.isArray(body.trackedDirs)) return sendJson(res, 400, { error: 'trackedDirs 必须是数组' });
      patch.trackedDirs = body.trackedDirs.map(d => (typeof d === 'string' ? { path: d } : d))
        .filter(d => d && d.path && path.isAbsolute(d.path) && path.resolve(d.path) !== '/')
        .map(d => ({ path: path.resolve(d.path), name: String(d.name || path.basename(d.path)), source: 'custom' }));
    }
    for (const k of ['thresholds', 'collect', 'terminal']) if (body[k] !== undefined) patch[k] = { ...config[k], ...body[k] };
    if (body.webhookUrl !== undefined) patch.webhookUrl = String(body.webhookUrl || '');
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: '没有可保存的变更' });
    saveConfig(patch);
    audit('config_change', { ip, keys: Object.keys(patch) });
    return sendJson(res, 200, { ok: true });
  }

  const mHost = p.match(/^\/api\/monitor\/hosts\/([^/]+)(\/.*)?$/);
  if (mHost) {
    const host = config.hosts.find(h => h.id === mHost[1]);
    if (!host) return sendJson(res, 404, { error: '主机不存在' });
    const sub = mHost[2] || '';
    if (sub === '' && req.method === 'GET') {
      const st = stateOf(host.id);
      return sendJson(res, 200, { id: host.id, name: host.name, online: st.online, error: st.error, snap: st.lastSnap });
    }
    if (sub === '/history' && req.method === 'GET') {
      const range = u.searchParams.get('range') || '1h';
      const h = histOf(host.id);
      let points;
      if (range === '1h') points = h.raw.slice(-RAW_CAP);
      else if (range === '24h') points = h.minute.slice(-MINUTE_CAP);
      else if (range === '7d') {
        points = [...h.minute];
        const days = Math.min(config.collect.retentionDays || 7, 30);
        for (let i = 1; i < days; i++) {
          const d = new Date(Date.now() - i * 86_400_000);
          const rows = readJsonlTail(path.join(HISTORY_DIR, host.id, `${d.toISOString().slice(0, 10)}.jsonl`), MINUTE_CAP);
          if (rows.length) points = [...rows, ...points];
        }
      } else return sendJson(res, 400, { error: 'range 仅支持 1h|24h|7d' });
      return sendJson(res, 200, { hostId: host.id, range, points });
    }
    if (sub === '/procs' && req.method === 'GET') {
      const dirFilter = u.searchParams.get('dir') || '';
      const st = stateOf(host.id);
      const detail = procDetailCache.get(host.id);
      if (!st.online || !detail) return sendJson(res, 200, { hostId: host.id, online: !!st.online, procs: [], dirs: [], error: st.error });
      const procs = dirFilter ? detail.procs.filter(x => x.dir === dirFilter) : detail.procs;
      return sendJson(res, 200, { hostId: host.id, online: true, t: st.lastSnap?.t, dirs: detail.dirs, procs, procsTotal: detail.procsTotal });
    }
    if (sub === '/probe' && req.method === 'POST') {
      if (!guard(req, res)) return;
      if (host.type === 'local') setTimeout(() => tickLocal(host).catch(() => {}), 0);
      else setTimeout(() => tickRemote(host).catch(() => {}), 0);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/monitor/dirs/history' && req.method === 'GET') {
    const hostId = u.searchParams.get('host') || '';
    if (!config.hosts.some(h => h.id === hostId)) return sendJson(res, 404, { error: '主机不存在' });
    const dirs = (u.searchParams.get('dirs') || '').split('|').filter(Boolean);
    const range = u.searchParams.get('range') || '1h';
    const h = histOf(hostId);
    let points;
    if (range === '1h') points = h.raw.slice(-RAW_CAP);
    else if (range === '24h') points = h.minute.slice(-MINUTE_CAP);
    else points = h.minute;
    const series = {};
    for (const d of dirs) {
      series[d] = points.map(pt => ({ t: pt.t, cpu: pt.dirs?.[d]?.cpu ?? null, mem: pt.dirs?.[d]?.mem ?? null, ioR: pt.dirs?.[d]?.ioR ?? null, ioW: pt.dirs?.[d]?.ioW ?? null }))
        .filter(x => x.cpu != null || x.mem != null);
    }
    return sendJson(res, 200, { hostId, range, series });
  }

  if (p === '/api/monitor/alerts' && req.method === 'GET') {
    const state = u.searchParams.get('state') || 'active';
    if (state === 'active') return sendJson(res, 200, { alerts: summaryPayload().alerts });
    return sendJson(res, 200, { alerts: readJsonlTail(ALERTS_PATH, Math.min(500, +u.searchParams.get('limit') || 100)).reverse() });
  }
  if (p === '/api/monitor/audit' && req.method === 'GET') {
    return sendJson(res, 200, { rows: readJsonlTail(AUDIT_PATH, Math.min(1000, +u.searchParams.get('limit') || 100)).reverse() });
  }

  return sendJson(res, 404, { error: 'not found' });
}

/* ============================ 启动 ============================ */
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--set-password-stdin') {
    const pw = fs.readFileSync(0, 'utf8').trim();
    if (pw.length < 8) { console.error('密码至少 8 位'); process.exit(1); }
    saveConfig({ auth: { ...config.auth, passwordHash: scryptHash(pw) } });
    sessions.clear();
    console.log('密码已更新');
    process.exit(0);
  }
  if (args[0] === '--set-cred') {
    const host = config.hosts.find(h => h.id === args[1]);
    if (!host) { console.error('主机不存在:', args[1]); process.exit(1); }
    if (args.includes('--password-stdin')) {
      const pw = fs.readFileSync(0, 'utf8').trim();
      credentials[host.id] = { ...(credentials[host.id] || {}), password: encSecret(pw) };
      saveCredentials();
      console.log(`已加密保存 ${host.id} 的密码凭据`);
    } else {
      console.log('用法: --set-cred <hostId> --password-stdin   （密钥认证直接在配置 hosts[].keyPath 指向私钥文件）');
    }
    process.exit(0);
  }

  reloadHomepageDirs();
  ensureDirSync(HISTORY_DIR);
  refreshDockerMap();
  setInterval(refreshDockerMap, (config.collect.dockerRefreshSec || 30) * 1000).unref();
  setInterval(cleanHistoryRetention, 6 * 3600 * 1000).unref();
  applyCollectors();

  const port = Number(process.env.MONITOR_PORT) || config.port || 8301;
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      log('请求处理异常:', e.message);
      try { sendJson(res, 500, { error: 'internal error' }); } catch {}
    });
  });
  server.on('upgrade', handleUpgrade);
  server.listen(port, '127.0.0.1', () => log(`监控网关已启动 http://127.0.0.1:${port}（API: /api/monitor/*，终端 WS: /api/terminal）`));

  const shutdown = () => { log('收到退出信号，关闭网关'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
