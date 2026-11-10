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
const PW_HASH_PATH = path.join(DATA_DIR, '.password-hash'); // scrypt 哈希落 gitignored 数据目录，配置文件不存任何密码材料
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
  auth: { sessionTtlHours: 8760, maxFailPerMin: 5 }, // 8760h = 1 年：同浏览器登录一次即长期免密（会话同时持久化到磁盘）
  collect: { localIntervalSec: 5, remoteIntervalSec: 20, retentionDays: 7, dockerRefreshSec: 30 },
  thresholds: { cpuPct: 85, memPct: 90, diskPct: 90, loadPerCore: 2, sustainMin: 3 },
  terminal: { idleTimeoutMin: 15, maxSessionMin: 240, maxSessionsPerHost: 2, recordCommands: true },
  webhookUrl: '',
  hosts: [],
  trackedDirs: [],
};
const HOST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const GENERIC_DIR_NAMES = new Set(['server', 'bin', 'dist', 'app', 'www', 'web', 'src', 'main', 'data']);
function defaultDirName(p) {
  const parts = String(p).split('/').filter(Boolean);
  const base = parts[parts.length - 1] || p;
  if (GENERIC_DIR_NAMES.has(base) && parts.length >= 2) return parts[parts.length - 2] + '/' + base;
  return base;
}
function normalizeHost(h) {
  if (!h || typeof h !== 'object' || !h.id) return null;
  if (!HOST_ID_RE.test(String(h.id))) return null;
  const out = { id: String(h.id), name: String(h.name || h.id), type: h.type === 'local' ? 'local' : 'ssh', group: String(h.group || '内网') };
  // 采集方式：ssh 中心主动拉取（默认） / agent 目标机常驻推送
  out.mode = h.mode === 'agent' ? 'agent' : 'ssh';
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
  // 双向同步标记：appSync = 回写应用中心（方向二，settings-server 消费）；syncSource = 条目来源（apps = 方向一创建）
  if (h.appSync) out.appSync = true;
  if (h.syncSource === 'apps' || h.syncSource === 'monitor') out.syncSource = h.syncSource;
  // 每主机跟踪目录：远程主机在此指定应用目录，目录级资源统计按主机维度生效
  out.trackedDirs = (Array.isArray(h.trackedDirs) ? h.trackedDirs : [])
    .map(d => (typeof d === 'string' ? { path: d } : d))
    .filter(d => d && d.path && path.isAbsolute(d.path) && path.resolve(d.path) !== '/')
    .map(d => ({ path: path.resolve(d.path), name: String(d.name || defaultDirName(d.path)), source: 'host' }));
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
/* 主机维度的跟踪目录集 = 全局自定义目录 + （仅本机）主页登记目录 + 该主机自己的目录 */
function effectiveTrackedDirsFor(host) {
  const map = new Map();
  const lists = [config.trackedDirs];
  if (host.type === 'local') lists.push(homepageDirs);
  lists.push(host.trackedDirs || []);
  for (const d of lists.flat()) {
    if (!map.has(d.path)) map.set(d.path, d);
  }
  return [...map.values()];
}

let configWatchTimer = null;
let homepageWatchTimer = null;
try {
  const cfgName = path.basename(CONFIG_PATH);
  const appsName = path.basename(APPS_CONFIG_PATH);
  fs.watch(path.dirname(CONFIG_PATH), (ev, fn) => {
    if (fn === cfgName) {
      clearTimeout(configWatchTimer);
      configWatchTimer = setTimeout(() => {
        try { config = loadConfigSync(); reloadHomepageDirs(); applyCollectors(); syncAppsToHosts(); log('配置热加载完成'); }
        catch (e) { log('配置热加载失败（保留旧配置）:', e.message); }
      }, 600);
      return;
    }
    /* 应用中心新增/删除/隐藏应用后，无需重启监控网关：自动刷新本机主页登记目录 */
    if (fn === appsName) {
      clearTimeout(homepageWatchTimer);
      homepageWatchTimer = setTimeout(() => {
        reloadHomepageDirs();
        syncAppsToHosts(); // 方向一：勾选 monitorSync 的远程应用自动登记为被监控主机
        log('主页应用目录热加载完成');
      }, 600);
    }
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

/* ============================ 方向一：应用中心 → 监控中心 同步 ============================
   apps.config.json 的 remoteApps[] 条目带 "monitorSync": true 时，自动在监控中心创建/更新
   同 id 的 SSH 主机（地址 = 应用 host，分组按 env 映射，gitDir 有值则预置跟踪目录）。
   规则：
   · 勾选 monitorSync 的应用是共享字段（name/group/address）的唯一事实源，
     但只回写 syncSource==='apps'（本方向创建）的主机，手工添加的同名主机不触碰；
   · 只创建与更新，从不删除：要移除请先在应用中心取消勾选，再在监控设置里删主机；
   · 凭据 / 端口 / 采集方式 / 跟踪目录等监控侧配置永不回写覆盖；
   · 无 diff 不写盘（防止与方向二互相触发形成回环）；
   · 单次同步因读写竞态/并发冲突中断时，由重试器按退避间隔自动重试。 */
function syncAppsToHostsOnce() {
  const appsRaw = JSON.parse(fs.readFileSync(APPS_CONFIG_PATH, 'utf8'));
  const monRaw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const hosts = Array.isArray(monRaw.hosts) ? monRaw.hosts : [];
  const claimed = new Set(); // 一台主机每轮只被第一个 monitorSync 应用占用，避免多应用同址时互相改名
  let changed = false;
  for (const a of (Array.isArray(appsRaw.remoteApps) ? appsRaw.remoteApps : [])) {
    if (!a || a.monitorSync !== true) continue;
    const id = String(a.id || '');
    let address = String(a.host || '');
    if (!address) { try { address = new URL(String(a.healthUrl || '')).hostname; } catch { /* 留空 */ } }
    if (!id || !address || !HOST_ID_RE.test(id)) { log('同步跳过（id 或 host 无效）:', id || '(空)'); continue; }
    const group = a.env === 'public' ? '公网' : '内网';
    /* 配对：优先同 id；id 未见则按地址配对已有 SSH 主机（真实场景监控主机 id 常与应用 id 不同）。
       syncSource==='apps' 的主机只认 id（不被其他应用地址抢占）；已被本轮其他应用占用的主机跳过。 */
    let existing = hosts.find((h) => h && h.id === id);
    let viaAddress = false;
    if (!existing) {
      existing = hosts.find((h) => h && h.type === 'ssh' && h.syncSource !== 'apps' && h.address === address && !claimed.has(h.id));
      viaAddress = !!existing;
    }
    if (!existing) {
      const host = {
        id, name: String(a.name || id), type: 'ssh', group,
        address, port: 22, username: 'root', authType: 'key', keyPath: '',
        mode: 'ssh', syncSource: 'apps',
        note: '由应用中心同步创建：请在监控设置中配置 SSH 密钥/密码（或自动部署）后开始采集',
        trackedDirs: [],
      };
      const gd = String(a.gitDir || '');
      if (path.isAbsolute(gd)) host.trackedDirs.push({ path: path.resolve(gd), name: defaultDirName(gd), source: 'host' });
      hosts.push(host);
      claimed.add(id);
      changed = true;
      log('已从应用中心同步创建主机:', id, '@', address);
    } else {
      claimed.add(existing.id);
      const nextName = String(a.name || id);
      if (existing.name !== nextName || existing.group !== group || existing.address !== address) {
        existing.name = nextName;
        existing.group = group;
        existing.address = address;
        changed = true;
        log(viaAddress
          ? `已按应用中心信息更新主机（按地址配对，应用 ${id} → 主机 ${existing.id}）`
          : '已按应用中心信息更新主机:', existing.id);
      }
    }
  }
  if (changed) saveConfig({ hosts });
  return changed;
}

/* 同步重试器：in-flight 期间的重复触发合并为一次（并发限制）；单次中断按
   10s/30s/60s/120s/120s 退避自动重试（最多 5 次）；新事件触发会重置退避立即执行。 */
function makeSyncRetryer(tag, fn) {
  const DELAYS = [10_000, 30_000, 60_000, 120_000, 120_000];
  let timer = null, attempt = 0, running = false, pendingAgain = false;
  const run = () => {
    if (running) { pendingAgain = true; return; }
    running = true;
    try {
      fn();
      attempt = 0;
    } catch (e) {
      if (attempt < DELAYS.length) {
        const delay = DELAYS[attempt++];
        log(`[${tag}] 同步中断，${Math.round(delay / 1000)}s 后自动重试（${attempt}/${DELAYS.length}）:`, e.message);
        clearTimeout(timer);
        timer = setTimeout(() => { run(); }, delay);
      } else {
        log(`[${tag}] 同步连续 ${DELAYS.length} 次失败，本轮放弃（下次配置变更或重启后再试）:`, e.message);
        attempt = 0;
      }
    } finally {
      running = false;
      if (pendingAgain) { pendingAgain = false; run(); }
    }
  };
  return () => { attempt = 0; clearTimeout(timer); run(); };
}
const syncAppsToHosts = makeSyncRetryer('apps→monitor', syncAppsToHostsOnce);

/* ============================ 同步检查（设置页「同步检查」数据源，只读实时计算） ============================
   配对规则与两个方向的同步函数保持一致：id 精确 → 地址精确（ssh 主机 ↔ remoteApp.host）；
   syncSource==='apps' 的主机不被其他应用地址抢占，monitorSync / syncSource==='monitor' 的应用不被其他主机地址抢占。 */
function syncCheckPayload() {
  let appsRaw = {};
  try { appsRaw = JSON.parse(fs.readFileSync(APPS_CONFIG_PATH, 'utf8')); } catch { /* 损坏时按空算，重试器会处理写侧 */ }
  const remoteApps = Array.isArray(appsRaw.remoteApps) ? appsRaw.remoteApps : [];
  const sshHosts = config.hosts.filter((h) => h.type === 'ssh');
  const envGroup = (env) => (env === 'public' ? '公网' : '内网');
  const groupEnv = (g) => (/公网|public/i.test(String(g || '')) ? 'public' : 'lan');

  const pairs = [];
  const unpairedApps = [];
  const unpairedHosts = [];
  const pairedKeys = new Set();   // 'appId|hostId'
  const pairedHostIds = new Set();

  /* 视角一：勾 monitorSync 的应用（应用为主） */
  for (const a of remoteApps) {
    if (!a || a.monitorSync !== true) continue;
    const addr = String(a.host || '');
    let h = config.hosts.find((x) => x && x.id === a.id);
    let via = h ? 'id' : '';
    if (!h && addr) h = sshHosts.find((x) => x.syncSource !== 'apps' && x.address === addr);
    if (h) via = via || 'address';
    if (!h) { unpairedApps.push({ appId: a.id, appName: a.name || a.id, host: addr, reason: '监控中心没有同 id 或同地址的主机（可能对端已删除）' }); continue; }
    pairedKeys.add(a.id + '|' + h.id);
    pairedHostIds.add(h.id);
    const wantName = String(a.name || a.id);
    const diffs = [];
    if (h.name !== wantName) diffs.push({ field: '主机名', from: h.name, to: wantName });
    if (h.group !== envGroup(a.env)) diffs.push({ field: '分组', from: h.group, to: envGroup(a.env) });
    if (h.address !== addr) diffs.push({ field: '地址', from: h.address, to: addr });
    pairs.push({ appId: a.id, appName: a.name || a.id, hostId: h.id, hostName: h.name, via, truth: 'app', diffs });
  }

  /* 视角二：勾 appSync 的主机（主机为主） */
  for (const h of config.hosts) {
    if (!h || h.appSync !== true || h.type !== 'ssh') continue;
    if (pairedHostIds.has(h.id)) continue; // 已按 monitorSync（应用为主）记录，避免同一配对报两遍
    const addr = String(h.address || '');
    let a = remoteApps.find((x) => x && x.id === h.id);
    let via = a ? 'id' : '';
    if (!a && addr) a = remoteApps.find((x) => x && x.syncSource !== 'monitor' && x.monitorSync !== true && x.host === addr);
    if (a) via = via || 'address';
    if (!a) { unpairedHosts.push({ hostId: h.id, hostName: h.name, address: addr, reason: '应用中心没有同 id 或同地址的远程应用（可能对端已删除）' }); continue; }
    pairedKeys.add(a.id + '|' + h.id);
    const wantName = String(h.name || h.id);
    const diffs = [];
    if (String(a.name || '') !== wantName) diffs.push({ field: '应用名', from: a.name || '', to: wantName });
    if (String(a.location || '') !== String(h.group || '')) diffs.push({ field: '位置', from: a.location || '', to: String(h.group || '') });
    if (String(a.env || '') !== groupEnv(h.group)) diffs.push({ field: '部署位置', from: a.env || '', to: groupEnv(h.group) });
    if (String(a.host || '') !== addr) diffs.push({ field: '主机地址', from: a.host || '', to: addr });
    pairs.push({ appId: a.id, appName: a.name || a.id, hostId: h.id, hostName: h.name, via, truth: 'host', diffs });
  }

  /* 候选：地址相同、两侧都没勾（可在设置里一键配对） */
  const candidates = [];
  for (const a of remoteApps) {
    if (!a || a.monitorSync === true) continue;
    const addr = String(a.host || '');
    if (!addr) continue;
    const h = sshHosts.find((x) => x.appSync !== true && x.address === addr && !pairedKeys.has(a.id + '|' + x.id));
    if (h) candidates.push({ appId: a.id, appName: a.name || a.id, hostId: h.id, hostName: h.name, address: addr });
  }

  return { serverTime: nowIso(), pairs, unpairedApps, unpairedHosts, candidates };
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
// CLI 子命令（--agent-install-cmd / --set-cred）会独立写此文件，热加载保持网关与 CLI 视图一致
let credsWatchTimer = null;
try {
  fs.watch(DATA_DIR, (ev, fn) => {
    if (fn !== path.basename(CREDS_PATH)) return;
    clearTimeout(credsWatchTimer);
    credsWatchTimer = setTimeout(() => {
      try { credentials = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); log('凭据库热加载完成'); }
      catch (e) { log('凭据库热加载失败（保留旧凭据）:', e.message); }
    }, 600);
  });
} catch (e) { log('凭据库 fs.watch 不可用:', e.message); }
function agentToken(hostId) {
  credentials.agents = credentials.agents || {};
  if (!credentials.agents[hostId]) {
    credentials.agents[hostId] = crypto.randomBytes(24).toString('hex');
    saveCredentials();
    log('已为主机生成 agent token:', hostId);
  }
  return credentials.agents[hostId];
}
function hostByAgentToken(token) {
  const agents = credentials.agents || {};
  const hostId = Object.keys(agents).find((id) => agents[id] === token);
  return hostId && config.hosts.find((h) => h.id === hostId) ? hostId : null;
}
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
function currentPasswordHash() {
  try {
    const h = fs.readFileSync(PW_HASH_PATH, 'utf8').trim();
    if (h.startsWith('scrypt$')) return h;
  } catch { /* 尚未生成 */ }
  return config.auth && config.auth.passwordHash; // 兼容旧版：配置文件里遗留的哈希
}
function writePasswordHash(hash) {
  ensureDirSync(DATA_DIR);
  fs.writeFileSync(PW_HASH_PATH, hash + '\n', { mode: 0o600 });
}
function ensurePasswordHash() {
  if (currentPasswordHash()) {
    // 迁移：把旧版存在配置文件里的哈希搬进数据目录，并从配置中剥离
    if (config.auth && config.auth.passwordHash) {
      writePasswordHash(config.auth.passwordHash);
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (raw.auth) delete raw.auth.passwordHash;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
      config = loadConfigSync();
      log('已将密码哈希迁移至', PW_HASH_PATH, '（配置文件不再保存密码材料）');
    }
    return;
  }
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let pw = '';
  const buf = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) pw += alphabet[buf[i] % alphabet.length];
  ensureDirSync(DATA_DIR);
  fs.writeFileSync(INITIAL_PW_PATH, pw + '\n', { mode: 0o600 });
  writePasswordHash(scryptHash(pw));
  log('首次启动：已生成随机初始密码 →', INITIAL_PW_PATH, '（请尽快登录后在设置中修改）');
}
ensurePasswordHash();

const sessions = new Map(); // token -> { expires, ip, created }；持久化到磁盘，网关重启不掉线
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
let sessionsDirty = false;
function markSessionsDirty() { sessionsDirty = true; }
function persistSessions() {
  if (!sessionsDirty) return;
  sessionsDirty = false;
  try {
    const obj = {};
    for (const [t, s] of sessions) obj[t] = s;
    const tmp = SESSIONS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, SESSIONS_PATH);
  } catch (e) { sessionsDirty = true; log('会话持久化失败:', e.message); }
}
function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    const now = Date.now();
    for (const [t, s] of Object.entries(raw)) if (s && s.expires > now) sessions.set(t, s);
  } catch { /* 首次或损坏则从空开始 */ }
}
const sessionTtlMs = () => (config.auth.sessionTtlHours || 8760) * 3600 * 1000;
function createSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + sessionTtlMs(), ip, created: Date.now() });
  markSessionsDirty();
  return token;
}
function getSession(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(m[1]); markSessionsDirty(); return null; }
  s.expires = Date.now() + sessionTtlMs(); // 滑动续期
  return m[1];
}
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expires) { sessions.delete(t); markSessionsDirty(); }
  persistSessions();
}, 60_000).unref();

const failCounter = new Map(); // ip -> {count, win}：只统计失败次数，成功登录不消耗配额
function rateLimited(ip) {
  const e = failCounter.get(ip);
  if (!e || Date.now() - e.win > 60_000) return false;
  return e.count >= (config.auth.maxFailPerMin || 5);
}
function recordAuthFail(ip) {
  const now = Date.now();
  const e = failCounter.get(ip);
  if (!e || now - e.win > 60_000) failCounter.set(ip, { count: 1, win: now });
  else e.count += 1;
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
  for (p in ut) print "PRC " p " " (rss[p] + 0) " " (thr[p] + 0) " " (ior[p] + 0) " " (iow[p] + 0) " " ut[p] " " st[p] " " cg[p]
}
' /proc/stat /proc/loadavg /proc/uptime /proc/meminfo /proc/net/dev /proc/diskstats /proc/mounts /proc/[0-9]*/stat /proc/[0-9]*/status /proc/[0-9]*/io /proc/[0-9]*/cgroup 2>/dev/null
# cmdline（第二遍 awk，RS='\0' 拼参数；用于解释器脚本的目录归属与进程名）
awk '
BEGIN { RS = "\0" }
FNR == 1 { pid = FILENAME; sub(/\/proc\//, "", pid); sub(/\/cmdline$/, "", pid); pid = pid + 0 }
{ cmd[pid] = cmd[pid] $0 " " }
END {
  print "===CMD==="
  for (p in cmd) print "CMD " p " " substr(cmd[p], 1, 160)
}
' /proc/[0-9]*/cmdline 2>/dev/null
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
echo "===CPUINFO==="
grep -m1 -E '^(model name|Hardware|Model)[[:space:]]*:' /proc/cpuinfo 2>/dev/null
echo "===DOCKER==="
command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Labels}}' 2>/dev/null
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
      // _password = 一次性明文（provision 流程传入），否则读加密存档
      const rec = credentials[creds._hostId];
      const pw = creds._password || (rec && rec.password ? decSecret(rec.password) : null);
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
  const c = { cpuLines: [], load: null, up: null, mem: {}, net: {}, dio: {}, mnts: [], procs: new Map(), df: [], osName: '', cpuModel: '', docker: new Map() };
  let section = 'MAIN';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '===PROCS===') { section = 'PROCS'; continue; }
    if (t === '===CMD===') { section = 'CMD'; continue; }
    if (t === '===PWD===') { section = 'PWD'; continue; }
    if (t === '===DF===') { section = 'DF'; continue; }
    if (t === '===OS===') { section = 'OS'; continue; }
    if (t === '===CPUINFO===') { section = 'CPUINFO'; continue; }
    if (t === '===DOCKER===') { section = 'DOCKER'; continue; }
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
      // 第 8 列 = docker cgroup id（旧版 agent/SSH 脚本无此列 → cg 留空，向后兼容）
      if (f[0] === 'PRC') c.procs.set(+f[1], { rssKb: +f[2] || 0, threads: +f[3] || 0, ioR: +f[4] || 0, ioW: +f[5] || 0, ut: +f[6] || 0, st: +f[7] || 0, cwd: '', exe: '', cmd: '', comm: '', fds: 0, cg: String(f[8] || '').slice(0, 64) });
    } else if (section === 'CMD') {
      // 行格式：CMD <pid> <参数串...>（供解释器脚本的目录归属与进程名）
      const f = t.split(/\s+/);
      if (f[0] === 'CMD') {
        const p = c.procs.get(+f[1]);
        if (p) { p.cmd = t.slice(t.indexOf(' ') + 1).split(/\s+/).slice(1).join(' ').slice(0, 200); }
      }
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
      // df -kPT 数据行 7 列：Filesystem Type 1024-blocks Used Available Capacity Mounted-on
      if (f[0] === 'Filesystem' || f[0] === '文件系统' || f.length < 7) continue;
      if (!REAL_FS.has(f[1])) continue;
      c.df.push({ fs: f[0], type: f[1], totalKb: +f[2] || 0, usedKb: +f[3] || 0, mnt: f.slice(6).join(' ') });
    } else if (section === 'DOCKER') {
      // 行格式：ID \t Names \t Image \t Labels（docker ps -a --format，\t 分隔）
      const parts = t.split('\t');
      const id = String(parts[0] || '').slice(0, 12);
      if (!/^[0-9a-f]{12}$/.test(id)) continue;
      let dir = '';
      for (const kv of String(parts.slice(3).join('\t') || '').split(',')) {
        const eq = kv.indexOf('=');
        if (eq > 0 && kv.slice(0, eq) === 'com.docker.compose.project.working_dir') { dir = kv.slice(eq + 1); break; }
      }
      if (!c.docker.has(id)) c.docker.set(id, { name: parts[1] || id, image: parts[2] || '', dir });
    } else if (section === 'OS') {
      const kv = t.split('=', 2);
      if (kv[0] === 'NAME' && kv[1]) c.osName = kv[1].replace(/"/g, '');
    } else if (section === 'CPUINFO') {
      const idx = t.indexOf(':');
      if (idx > 0) c.cpuModel = t.slice(idx + 1).trim();
    }
  }
  // 同一设备多次挂载（bind）去重：保留最上层（首次出现）挂载点
  const seenFs = new Set();
  c.df = c.df.filter(d => (seenFs.has(d.fs) ? false : (seenFs.add(d.fs), true)));
  return c;
}

/* ============================ 本机采集（直读 /proc，零子进程） ============================ */
function readLocalCounters(trackedDirs) {
  const c = { cpuLines: [], load: null, up: null, mem: {}, net: {}, dio: {}, mnts: [], procs: new Map(), df: [], osName: '', cpuModel: '' };
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
    c.cpuModel = os.cpus()[0] ? os.cpus()[0].model.trim() : '';
    c.osName = `${os.type()} ${os.release()}`;
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
  const dirs = trackedDirs;
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

function buildSnapshot(hostId, counters, prev, intervalSec, isFirst, dirsCfg) {
  const dirMap = new Map(dirsCfg.map(d => [d.path, d]));
  // 容器映射按主机取：远程/agent 采集体自带 DOCKER 段（c.docker）；本机采集体无此字段 → 用中心的 dockerMap
  const dmap = counters.docker instanceof Map ? counters.docker : dockerMap;
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
    // 远程进程无 _dir 预计算，现场按 cwd/exe/cmdline 归属（远程脚本无 exe，靠 cwd+cmd 兜底）
    let dirPath = p._dir;
    if (!dirPath) {
      const hit = matchDirOf(p, dirsCfg);
      if (hit) dirPath = hit.path;
    }
    if (dirPath && dirMap.has(dirPath)) {
      const dc = dirMap.get(dirPath);
      groupName = dc.name; groupPath = dc.path; groupSource = dc.source;
    } else if (p.cg) {
      const info = dmap.get(p.cg.slice(0, 12));
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
    cpu: { pct: cpu.pct == null ? null : +cpu.pct.toFixed(1), cores: coreN, model: counters.cpuModel || '', perCore: cpu.perCore.map(x => x == null ? null : +x.toFixed(1)), load1: counters.load?.[0] ?? null, load5: counters.load?.[1] ?? null, load15: counters.load?.[2] ?? null, loadPerCore: counters.load ? +(counters.load[0] / coreN).toFixed(2) : null },
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
/* 分钟滚动：把 lastMinuteTs 起到 upToTs 之间的每个分钟补齐——正常路径聚合窗口均值，
   离线/无数据的窗口产出全 null 分钟点（JSONL 保持连续，图表断线可见而非整段缺失）；
   超过 24h 的空洞（主机长期离线后回归）直接快进，不批量补 null。 */
function rollMinute(h, upToTs, hostId) {
  if (!h.lastMinuteTs || upToTs <= h.lastMinuteTs) return;
  if (upToTs - h.lastMinuteTs > 86_400_000) { h.lastMinuteTs = upToTs; return; }
  while (h.lastMinuteTs + 60_000 <= upToTs) {
    const start = h.lastMinuteTs;
    const window = h.raw.filter(p => p.t >= start && p.t < start + 60_000);
    const avg = window.length
      ? avgPoints(window, start)
      : { t: start, cpu: null, load: null, loadN: null, mem: null, swap: null, disks: [], dioR: null, dioW: null, netI: null, netO: null, dirs: {}, offline: true };
    h.minute.push(avg);
    if (h.minute.length > MINUTE_CAP) h.minute.shift();
    appendJsonl(path.join(HISTORY_DIR, hostId, `${new Date(start).toISOString().slice(0, 10)}.jsonl`), avg);
    h.lastMinuteTs = start + 60_000;
  }
}
function pushHistory(hostId, snap) {
  const h = histOf(hostId);
  h.raw.push(compactPoint(snap));
  if (h.raw.length > RAW_CAP) h.raw.shift();
  const minuteTs = Math.floor(snap.t / 60_000) * 60_000;
  rollMinute(h, minuteTs, hostId);
  if (!h.lastMinuteTs) h.lastMinuteTs = minuteTs;
}
function pushHistoryOffline(hostId, t) {
  const h = histOf(hostId);
  h.raw.push({ t, cpu: null, load: null, loadN: null, mem: null, swap: null, disks: [], dioR: null, dioW: null, netI: null, netO: null, dirs: {}, offline: true });
  if (h.raw.length > RAW_CAP) h.raw.shift();
  const minuteTs = Math.floor(t / 60_000) * 60_000;
  rollMinute(h, minuteTs, hostId);
  if (!h.lastMinuteTs) h.lastMinuteTs = minuteTs;
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
  // 遍历磁盘目录而非内存 history keys：已删除主机的残留历史也能按保留期清掉
  let hostIds;
  try { hostIds = fs.readdirSync(HISTORY_DIR); } catch { return; }
  for (const hostId of hostIds) {
    const dir = path.join(HISTORY_DIR, hostId);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    let removed = 0;
    for (const f of files) {
      const ts = Date.parse(f.replace('.jsonl', 'T00:00:00Z'));
      if (!Number.isFinite(ts) || ts >= cutoff) continue;
      try { fs.unlinkSync(path.join(dir, f)); removed++; } catch { /* 已删 */ }
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* 非空 */ }
    if (removed) log('历史清理:', hostId, `删除 ${removed} 个过期文件`);
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
    const counters = readLocalCounters(effectiveTrackedDirsFor(host));
    const interval = st.prev ? Math.max(0.5, (t0 - (st.prev.t || t0)) / 1000) : 0;
    const { snap, prev, detail } = buildSnapshot(host.id, counters, st.prev, interval, !st.prev, effectiveTrackedDirsFor(host));
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
    const { snap, prev, detail } = buildSnapshot(host.id, counters, st.prev, interval, !st.prev, effectiveTrackedDirsFor(host));
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
  /* 主机被删除后释放其内存态（历史/状态/进程缓存）；磁盘历史由 cleanHistoryRetention 按保留期清掉 */
  const live = new Set(config.hosts.map(h => h.id));
  for (const id of [...history.keys()]) if (!live.has(id)) history.delete(id);
  for (const id of [...hostState.keys()]) if (!live.has(id)) hostState.delete(id);
  for (const id of [...procDetailCache.keys()]) if (!live.has(id)) procDetailCache.delete(id);
  for (const host of config.hosts) {
    loadHistoryFromDisk(host.id);
    if (host.type === 'local') {
      collectorTimers.push(setInterval(() => tickLocal(host).catch(() => {}), (config.collect.localIntervalSec || 5) * 1000));
      setTimeout(() => tickLocal(host).catch(() => {}), 200);
    } else if (host.mode === 'agent') {
      // agent 推送模式：不主动连接；看门狗只判定静默掉线（推送到达由 push 端点驱动采集管线）
      collectorTimers.push(setInterval(() => {
        const st = stateOf(host.id);
        if (st.online && Date.now() - st.lastOk > 70_000) {
          st.online = false;
          st.error = 'agent 未上报（>70 秒）';
          pushHistoryOffline(host.id, Date.now());
        }
      }, 10_000));
    } else {
      collectorTimers.push(setInterval(() => tickRemote(host).catch(() => {}), (config.collect.remoteIntervalSec || 20) * 1000));
      setTimeout(() => tickRemote(host).catch(() => {}), 800 + Math.floor(Math.random() * 3000));
    }
  }
}

/* ============================ Agent 推送模式 ============================ */
function localLanAddress() {
  const local = config.hosts.find((h) => h.type === 'local');
  if (local && local.address) return local.address;
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
function agentPushUrl() { return `http://${localLanAddress()}/api/monitor/agent`; }

function buildAgentInstaller(host, intervalSec) {
  const token = agentToken(host.id);
  const center = agentPushUrl();
  // 采集体与 SSH 探测脚本同源（含 awk 的 $ 符号，必须以引用型 heredoc 原样落盘）
  const collector = REMOTE_PROBE_AWK + REMOTE_PROBE_SHELL;
  const body = [
    '#!/bin/sh',
    '# my-homepage 监控 agent（中心生成，勿手改）',
    "CENTER='" + center + "'",
    "TOKEN='" + token + "'",
    'INTERVAL=' + (intervalSec || 20),
    '',
    'collect() {',
    collector,
    '}',
    '',
    'while :; do',
    '  out=$(collect 2>/dev/null)',
    '  if [ -n "$out" ]; then',
    '    curl -fsS -m 10 -H "X-Agent-Token: $TOKEN" -H "Content-Type: text/plain" --data-binary "$out" "$CENTER/push" >/dev/null 2>&1 || :',
    '  fi',
    '  sleep "$INTERVAL"',
    'done',
    '',
  ].join('\n');
  return `#!/bin/sh
# my-homepage 监控 agent 一键安装 · 主机 ${host.id} · 幂等可重装
set -e
cat > /usr/local/bin/my-homepage-agent.sh <<'AGENT_BODY'
${body}
AGENT_BODY
chmod 700 /usr/local/bin/my-homepage-agent.sh

if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/my-homepage-agent.service <<'UNIT_EOF'
[Unit]
Description=my-homepage monitor agent (push to center)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh /usr/local/bin/my-homepage-agent.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT_EOF
  systemctl daemon-reload
  if systemctl cat my-homepage-agent.service >/dev/null 2>&1 && systemctl is-active --quiet my-homepage-agent.service; then
    systemctl restart my-homepage-agent.service
  else
    systemctl enable --now my-homepage-agent.service
  fi
  echo "agent 服务已启动：systemctl status my-homepage-agent"
else
  pkill -f my-homepage-agent.sh 2>/dev/null || :
  nohup /usr/local/bin/my-homepage-agent.sh >/dev/null 2>&1 &
  (crontab -l 2>/dev/null | grep -v my-homepage-agent.sh; echo "@reboot /usr/local/bin/my-homepage-agent.sh >/dev/null 2>&1") | crontab -
  echo "agent 已以 nohup + cron 方式常驻"
fi
`;
}


/* ============================ 自动纳管（密码 → 免密 + Agent 安装） ============================ */
function sshKeygen(hostId) {
  const dir = path.join(DATA_DIR, 'keys');
  ensureDirSync(dir);
  const keyPath = path.join(dir, hostId);
  return new Promise((resolve, reject) => {
    if (fs.existsSync(keyPath)) return resolve({ keyPath, created: false });
    execFile('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'my-homepage-monitor-' + hostId, '-q'], (err) => {
      if (err) return reject(err);
      try { fs.chmodSync(keyPath, 0o600); } catch { /* 忽略 */ }
      resolve({ keyPath, created: true });
    });
  });
}

/* 一次 SSH exec 完成：免密公钥写入 + agent 安装器直灌（不经 HTTP，无 curl 依赖） */
async function sshExecScript(creds, script, timeoutMs = 30_000) {
  const conn = await connectSSH(creds, 15_000);
  try {
    return await new Promise((resolve, reject) => {
      conn.exec('sh -s', (err, stream) => {
        if (err) return reject(err);
        let out = '';
        const t = setTimeout(() => reject(new Error('执行超时')), timeoutMs);
        stream.on('data', (d) => { out += d.toString(); });
        stream.stderr.on('data', () => {});
        stream.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error('远端执行失败 exit=' + code + '：' + out.slice(-300))); });
        stream.end(script);
      });
    });
  } finally { try { conn.end(); } catch { /* 已关 */ } }
}

async function provisionHost(hostDraft, password, ip) {
  const steps = [];
  const draft = normalizeHost({ ...hostDraft, mode: 'ssh' });
  if (!draft) throw new Error('主机配置无效（id 仅限字母数字-_，且必填）');
  if (draft.type !== 'ssh') throw new Error('仅远程 SSH 主机支持自动部署');
  if (!draft.address) throw new Error('缺少目标机地址');
  if (!password) throw new Error('缺少目标机密码');
  audit('provision_start', { host: draft.id, ip });

  // 注意：saveConfig 末尾会 loadConfigSync() 重建 config.hosts，
  // 因此每次改动都必须「重定位当前主机对象 → 改 → 立刻保存」，不能跨保存持有旧引用。
  const upsert = (mut) => {
    const i = config.hosts.findIndex((h) => h.id === draft.id);
    const base = i >= 0 ? config.hosts[i] : normalizeHost({ ...draft });
    if (i >= 0) config.hosts[i] = base; else config.hosts.push(base);
    mut(base);
    saveConfig({ hosts: config.hosts });
    return config.hosts.find((h) => h.id === draft.id);
  };

  // 1) 入库（部署期先用密码连接）
  const saved0 = upsert((h) => {
    h.name = draft.name; h.group = draft.group; h.mode = 'ssh';
    h.address = draft.address; h.port = draft.port; h.username = draft.username;
    h.authType = 'password'; delete h.keyPath; h.trackedDirs = h.trackedDirs || [];
  });
  steps.push(`主机配置已保存（${saved0.id} @ ${saved0.address}）`);

  // 2) 监控专用密钥（无则生成）
  const { keyPath, created } = await sshKeygen(draft.id);
  steps.push(created ? '已生成监控专用密钥 ed25519' : '复用已有监控专用密钥');

  // 3) 一次 SSH（密码认证）：写免密公钥 + 直灌 agent 安装器
  const pub = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
  const installer = buildAgentInstaller({ ...saved0, keyPath }, config.collect.remoteIntervalSec || 20);
  const remoteScript = [
    'set -e',
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
    `grep -qF '${pub}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys`,
    "cat > /tmp/.my-agent-install.sh <<'INSTALLER_EOF'",
    installer,
    'INSTALLER_EOF',
    'sh /tmp/.my-agent-install.sh',
    'rm -f /tmp/.my-agent-install.sh',
  ].join('\n');
  const creds = { ...getConnCreds(saved0), authType: 'password', _password: password };
  const out = await sshExecScript(creds, remoteScript, 40_000);
  const tail = out.trim().split('\n').pop().trim();
  steps.push('免密公钥已写入 authorized_keys；agent 安装器已执行（' + tail.slice(0, 90) + '）');

  // 4) 免密验证（key 认证；验证后必须关闭连接，否则 keepalive 会长期挂着）
  const verifyConn = await connectSSH({ ...creds, authType: 'key', keyPath }, 12_000);
  try { verifyConn.end(); } catch { /* 已关 */ }
  steps.push('免密登录验证通过（BatchMode，无密码）');

  // 5) 落盘 keyPath + 切换 Agent 推送模式；密码凭据加密存档备用
  const saved = upsert((h) => {
    h.keyPath = keyPath;
    h.authType = 'key';
    h.mode = 'agent';
  });
  credentials[draft.id] = { ...(credentials[draft.id] || {}), password: encSecret(password) };
  saveCredentials();
  steps.push('已切换为 Agent 推送模式 + 密码凭据加密存档（备用；不落明文不入 git）');
  steps.push(`等待首次推送（≤${config.collect.remoteIntervalSec || 20}s）`);

  // 6) 立即触发一次采集管线（applyCollectors 已按新配置重建定时器）
  applyCollectors();
  audit('provision_ok', { host: saved.id, ip });
  return { host: saved, steps };
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
  const pendingInput = []; // shell 就绪前到达的键盘输入（跨公网握手可达数秒），就绪后回放
  ws.idleTs = Date.now();

  const cleanup = (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer); clearTimeout(maxTimer);
    if (counted) termSessions.set(hostId, Math.max(0, (termSessions.get(hostId) || 1) - 1))
    /* 尾部未回车的命令也入审计 */
    if (cmdBuf.trim()) {
      const clean = cmdBuf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, '').trim()
      if (clean) cmds.push(clean.slice(0, 200))
    };
    try { conn.end(); } catch {}
    audit('session_close', { sid: sessId, host: hostId, user: creds.username, ip, durationSec: Math.round((Date.now() - openedAt) / 1000), reason, commands: termCfg.recordCommands ? cmds.slice(-500) : undefined });
  };
  const idleTimer = setInterval(() => { if (Date.now() - ws.idleTs > (termCfg.idleTimeoutMin || 15) * 60_000) { try { ws.close(4001, '空闲超时'); } catch {} } }, 30_000);
  const maxTimer = setTimeout(() => { try { ws.close(4002, '会话时长达到上限'); } catch {} }, (termCfg.maxSessionMin || 240) * 60_000);

  ws.on('message', (data) => {
    ws.idleTs = Date.now();
    if (!shellStream) {
      // shell 未就绪：缓冲输入（上限 8KB，防止异常连接撑爆内存）
      const q = Buffer.from(data);
      if (q.length && pendingInput.length < 64 && pendingInput.reduce((a, b) => a + b.length, 0) < 8192) pendingInput.push(q);
      return;
    }
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
      while (pendingInput.length) shellStream.write(pendingInput.shift()); // 回放就绪前的输入
      stream.on('data', (d) => { ws.idleTs = Date.now(); if (ws.readyState === 1) ws.send(d); });
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
/* 解析 JSON 请求体：坏 JSON / 空请求体统一 400（此前抛给 route 兜底成 500，排障语义差） */
async function readJsonBody(req, res, limit) {
  try { return JSON.parse((await readBody(req, limit)) || '{}'); }
  catch { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return null; }
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
      mode: h.mode || 'ssh',
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

  if (p === '/api/monitor/agent/push' && req.method === 'POST') {
    const token = req.headers['x-agent-token'] || u.searchParams.get('token') || '';
    const hostId = hostByAgentToken(String(token));
    if (!hostId) { audit('agent_push_denied', { ip }); return sendJson(res, 401, { error: '无效 agent token' }); }
    const host = config.hosts.find((h) => h.id === hostId);
    if (!host) return sendJson(res, 404, { error: '主机不存在' });
    const text = await readBody(req, 512 * 1024);
    if (!text.trim()) return sendJson(res, 400, { error: '空载荷' });
    const st = stateOf(host.id);
    const t0 = Date.now();
    try {
      const counters = parseRemoteOutput(text);
      const interval = st.prev ? Math.max(0.5, (t0 - (st.prev.t || t0)) / 1000) : 0;
      const { snap, prev, detail } = buildSnapshot(host.id, counters, st.prev, interval, !st.prev, effectiveTrackedDirsFor(host));
      prev.t = t0;
      st.prev = prev;
      finishTick(host, snap, detail);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      st.online = false; st.error = String(e.message || e);
      return sendJson(res, 500, { error: '解析失败' });
    }
  }

  if (p === '/api/monitor/agent/install.sh' && req.method === 'GET') {
    const token = String(u.searchParams.get('token') || '');
    const hostId = hostByAgentToken(token);
    if (!hostId) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('无效 token'); }
    const host = config.hosts.find((h) => h.id === hostId);
    const interval = Math.min(300, Math.max(5, +u.searchParams.get('interval') || 20));
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(buildAgentInstaller(host, interval));
  }

  if (p === '/api/monitor/login' && req.method === 'POST') {
    if (rateLimited(ip)) { audit('auth_fail', { ip, reason: 'rate_limited' }); return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' }); }
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!verifyPassword(body.password || '', currentPasswordHash())) { recordAuthFail(ip); audit('auth_fail', { ip }); return sendJson(res, 401, { error: '密码错误' }); }
    const token = createSession(ip);
    audit('auth_ok', { ip });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionTtlMs() / 1000}` });
  }
  if (p === '/api/monitor/logout' && req.method === 'POST') {
    const token = getSession(req);
    if (token) { sessions.delete(token); markSessionsDirty(); }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  // —— 以下全部要求会话 ——
  if (!getSession(req)) return sendJson(res, 401, { error: '未登录或会话已过期' });

  if (p === '/api/monitor/summary' && req.method === 'GET') return sendJson(res, 200, summaryPayload());

  if (p === '/api/monitor/sync-check' && req.method === 'GET') return sendJson(res, 200, syncCheckPayload());

  if (p === '/api/monitor/sync-run' && req.method === 'POST') {
    if (!guard(req, res)) return;
    syncAppsToHosts(); // 方向一立即重跑（重试器内含并发合并）
    // 触发方向二：settings-server 监听 monitor.config.json 变更事件，utimes 不改内容仅唤醒其防抖回调
    try { const st = fs.statSync(CONFIG_PATH); fs.utimesSync(CONFIG_PATH, st.atime, new Date()); } catch { /* 忽略 */ }
    audit('sync_run', { ip });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/monitor/hosts/provision' && req.method === 'POST') {
    if (!guard(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!body.host || !body.password) return sendJson(res, 400, { error: '缺少主机信息或密码' });
    try {
      const r = await provisionHost(body.host, String(body.password), ip);
      return sendJson(res, 200, { ok: true, host: r.host, steps: r.steps });
    } catch (e) {
      audit('provision_fail', { ip, host: body.host?.id, error: String(e.message || e).slice(0, 200) });
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/monitor/password' && req.method === 'POST') {
    if (!guard(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!verifyPassword(body.oldPassword || '', currentPasswordHash())) return sendJson(res, 401, { error: '旧密码错误' });
    if (!body.newPassword) return sendJson(res, 400, { error: '新密码不能为空' });
    writePasswordHash(scryptHash(body.newPassword));
    // 按用户要求：改密后保留既有会话，同浏览器无需重新输入密码
    audit('password_change', { ip });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/monitor/config' && req.method === 'GET') {
    const { auth, ...rest } = config;
    /* effectiveDirs：只读的生效目录集（全局 + 本机主页登记 + 该主机自有 + 运行时自动发现的容器目录），
       供设置页展示；PUT 时 normalizeHost 会丢弃该字段，不会写回配置 */
    const hosts = (rest.hosts || []).map(h => {
      const seen = new Set();
      const dirs = [...effectiveTrackedDirsFor(h)];
      for (const d of dirs) seen.add(d.path);
      for (const d of (stateOf(h.id).lastSnap?.dirs || [])) {
        if (d.source === 'container' && !seen.has(d.path)) { seen.add(d.path); dirs.push({ path: d.path, name: d.name, source: 'container' }); }
      }
      return { ...h, effectiveDirs: dirs };
    });
    return sendJson(res, 200, { ...rest, hosts, hasPassword: !!auth?.passwordHash });
  }
  if (p === '/api/monitor/config' && req.method === 'PUT') {
    if (!guard(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
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
    if (sub === '/agent-install' && req.method === 'GET') {
      const interval = Math.min(300, Math.max(5, +u.searchParams.get('interval') || 20));
      const cmd = `curl -fsSL 'http://${localLanAddress()}/api/monitor/agent/install.sh?token=${agentToken(host.id)}&interval=${interval}' | sh`;
      return sendJson(res, 200, { cmd, interval });
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
    if (!pw) { console.error('密码不能为空'); process.exit(1); }
    writePasswordHash(scryptHash(pw));
    sessions.clear();
    console.log('密码已更新');
    process.exit(0);
  }
  if (args[0] === '--agent-install-cmd') {
    const host = config.hosts.find((h) => h.id === args[1]);
    if (!host) { console.error('主机不存在:', args[1]); process.exit(1); }
    const interval = Math.min(300, Math.max(5, +args[args.indexOf('--interval') + 1] || 20));
    console.log(`在目标服务器上以 root 执行：`);
    console.log(`curl -fsSL 'http://${localLanAddress()}/api/monitor/agent/install.sh?token=${agentToken(host.id)}&interval=${interval}' | sh`);
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
  syncAppsToHosts(); // 启动时做一次方向一同步（自愈：补齐曾被整表保存覆盖掉的同步主机）
  ensureDirSync(HISTORY_DIR);
  loadSessions();
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

  const shutdown = () => { log('收到退出信号，关闭网关'); persistSessions(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
