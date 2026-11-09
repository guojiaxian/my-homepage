<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { monApi, fmtMbs, fmtPct, fmtUptime } from '../lib/monitor-api.js'
import MonitorDetail from './MonitorDetail.vue'
import MonitorSettings from './MonitorSettings.vue'
import MonitorTerm from './MonitorTerm.vue'

/* active：是否为当前顶层视图（App.vue v-show 常驻，由父级告知）。
   v-if/v-else 分支会让 <KeepAlive> 自身被销毁重建、缓存失效，故改用 v-show + active 自管轮询。 */
const props = defineProps({ active: { type: Boolean, default: false } })

/* ---------- 状态 ---------- */
const authed = ref(false)
const summary = ref(null)
const loadErr = ref('')
const selectedId = ref('')
const settingsOpen = ref(false)
const termHost = ref(null) // { id, name }
const loginPw = ref('')
const loginErr = ref('')
const loginBusy = ref(false)

let pollTimer = null
let started = false

const hosts = computed(() => summary.value?.hosts || [])
const alerts = computed(() => summary.value?.alerts || [])
const onlineCount = computed(() => hosts.value.filter((h) => h.online).length)
const trackedDirCount = computed(() => {
  let n = 0
  for (const h of hosts.value) if (h.online && h.snap) n = Math.max(n, (h.snap.dirs || []).length)
  return n
})
const containerCount = computed(() =>
  hosts.value.reduce((a, h) => a + (h.online && h.snap ? h.snap.containersCount || 0 : 0), 0),
)
const selectedHost = computed(() => hosts.value.find((h) => h.id === selectedId.value) || null)
const thresholds = ref({})

/* ---------- 数据 ---------- */
async function refresh() {
  if (document.hidden || !authed.value) return
  try {
    summary.value = await monApi('/api/monitor/summary')
    loadErr.value = ''
  } catch (e) {
    if (e.authRequired) { authed.value = false; stopPoll() }
    /* 其余错误静默，下轮重试 */
  }
}
async function boot() {
  try {
    summary.value = await monApi('/api/monitor/summary')
    authed.value = true
    loadErr.value = ''
    monApi('/api/monitor/config').then((c) => { thresholds.value = c.thresholds || {} }).catch(() => {})
    startPoll()
  } catch (e) {
    authed.value = false
    loadErr.value = e.authRequired ? '' : e.message
  }
}
function startPoll() {
  stopPoll()
  pollTimer = setInterval(refresh, 5_000)
  refresh()
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

/* 视图激活时启动（首次 boot / 恢复轮询），离开时停止 */
watch(
  () => props.active,
  (v) => {
    if (v) {
      if (!started) { started = true; boot() }
      else if (authed.value) startPoll()
    } else {
      stopPoll()
    }
  },
  { immediate: true },
)

/* ---------- 登录 ---------- */
async function doLogin() {
  loginBusy.value = true
  loginErr.value = ''
  try {
    await monApi('/api/monitor/login', { method: 'POST', body: { password: loginPw.value } })
    loginPw.value = ''
    authed.value = true
    startPoll()
  } catch (e) {
    loginErr.value = e.authRequired ? '密码错误' : e.message
  } finally { loginBusy.value = false }
}

/* ---------- 交互 ---------- */
function toggleDetail(h) {
  selectedId.value = selectedId.value === h.id ? '' : h.id
}
function openTerm(h) { termHost.value = { id: h.id, name: h.name } }
function onSaved() { refresh() }

/* ---------- 卡片渲染辅助 ---------- */
function isPublic(h) { return /公网|public/i.test(h.group || '') }
function dotCls(h) {
  if (h.online) return 'ok'
  return h.credReady ? 'err' : 'off'
}
function gauges(h) {
  const s = h.snap || {}
  const worstDisk = (s.disks || []).filter((d) => d.pct != null).sort((a, b) => b.pct - a.pct)[0]
  return [
    { cap: 'CPU', v: s.cpu?.pct },
    { cap: '内存', v: s.mem?.pct },
    { cap: '磁盘', v: worstDisk?.pct, title: worstDisk ? `${worstDisk.mnt} ${worstDisk.pct}%` : '' },
  ]
}
function gaugeCls(v) {
  const x = Number(v)
  if (!isFinite(x)) return ''
  return x >= 88 ? 'crit' : x >= 70 ? 'warn' : ''
}
function dirCount(h) { return h.snap?.dirs?.length || 0 }
</script>

<template>
  <div v-show="active">
    <!-- 登录（仅在本视图激活且未鉴权时显示） -->
    <div v-if="active && !authed" class="mon-login-mask">
      <form class="mon-login" @submit.prevent="doLogin">
        <h1>监控中心</h1>
        <p>首次访问输入一次密码即可，本浏览器将长期记住，无需重复登录</p>
        <input v-model="loginPw" type="password" placeholder="访问密码" autocomplete="current-password" />
        <p class="login-err">{{ loginErr || loadErr }}</p>
        <button type="submit" class="login-btn" :disabled="loginBusy">{{ loginBusy ? '登录中…' : '登 录' }}</button>
      </form>
    </div>

    <template v-else>
      <!-- 概览 hero：与主页同结构 -->
      <section class="hero">
        <h1>监控中心</h1>
        <p class="sub">本机与远程服务器实时指标 · 每 5 秒自动刷新 · 点击卡片查看详情并进入终端</p>
        <div class="stats">
          <span class="stat-chip">
            <span class="dot" :style="{ background: onlineCount === hosts.length && hosts.length ? 'var(--green)' : 'var(--amber)' }" />
            <b>{{ onlineCount }}</b>/{{ hosts.length }} 主机在线
          </span>
          <span class="stat-chip" :style="alerts.length ? 'color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--border))' : ''">
            <span class="dot" :style="{ background: alerts.length ? 'var(--red)' : 'var(--green)' }" />
            <template v-if="alerts.length"><b>{{ alerts.length }}</b> 个活跃告警</template>
            <template v-else>无活跃告警</template>
          </span>
          <span class="stat-chip">跟踪 <b>{{ trackedDirCount }}</b> 个目录</span>
          <span class="stat-chip"><b>{{ containerCount }}</b> 个容器</span>
        </div>
      </section>

      <!-- 活跃告警横幅 -->
      <div v-if="alerts.length" class="alert-banner">
        <div v-for="a in alerts" :key="a.id" class="alert-item" :class="{ warn: a.level === 'warn' }">
          <span class="alert-dot" />
          <b>{{ a.label }}</b>
          <span class="sub">阈值 {{ a.threshold }} · {{ hosts.find((x) => x.id === a.hostId)?.name || a.hostId }}</span>
        </div>
      </div>

      <!-- 主机区 -->
      <div class="mon-toolbar">
        <h2>主机</h2>
        <span class="sub">内网蓝 / 公网橙 · 点击卡片展开详情</span>
        <span class="grow" />
        <span class="sub num" v-if="summary">更新于 {{ new Date(summary.serverTime).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
        <button class="ghost-btn" @click="settingsOpen = true">⚙ 监控设置</button>
      </div>

      <div v-if="!hosts.length" class="mon-empty">还没有纳管主机，点击右上角「⚙ 监控设置」添加。</div>

      <div v-else class="host-grid">
        <article
          v-for="h in hosts"
          :key="h.id"
          class="host-card"
          :class="{ public: isPublic(h), selected: selectedId === h.id, offline: !h.online }"
          @click="toggleDetail(h)"
        >
          <div class="hc-top">
            <span class="status-dot" :class="dotCls(h)" :title="h.online ? '在线' : h.error || '待配置'" />
            <span class="hc-name">{{ h.name }}</span>
            <span class="env-chip" :class="{ public: isPublic(h) }">{{ h.group }}</span>
            <span class="grow" />
            <span class="hc-addr">{{ h.address }}</span>
          </div>
          <div class="hc-os" :title="h.snap?.os">{{ h.snap?.os || (h.credReady ? '' : 'SSH 凭据待配置') }}</div>

          <template v-if="h.online && h.snap">
            <div class="hc-main">
              <div class="gauges">
                <div
                  v-for="g in gauges(h)"
                  :key="g.cap"
                  class="gauge"
                  :class="gaugeCls(g.v)"
                  :style="{ '--v': isFinite(+g.v) ? +g.v : 0 }"
                  :title="g.title || g.cap"
                >
                  <span class="g-val">{{ fmtPct(g.v) }}<i>%</i></span>
                  <span class="g-cap">{{ g.cap }}</span>
                </div>
              </div>
              <div class="hc-stats">
                <div><span>负载</span><b>{{ h.snap.cpu?.load1 ?? '-' }} <i>/ {{ h.snap.cpu?.loadPerCore ?? '-' }} 核</i></b></div>
                <div><span>网络</span><b>↑ {{ fmtMbs(h.snap.net?.outMbs) }} <i>↓ {{ fmtMbs(h.snap.net?.inMbs) }} Mbps</i></b></div>
                <div><span>运行</span><b>{{ fmtUptime(h.snap.uptimeSec) }}</b></div>
              </div>
            </div>
            <div class="hc-foot">
              <span class="hint">跟踪 {{ dirCount(h) }} 目录<template v-if="h.snap.containersCount"> · 容器 {{ h.snap.containersCount }}</template></span>
              <span class="grow" />
              <button class="mini-btn" @click.stop="toggleDetail(h)">{{ selectedId === h.id ? '收起' : '详情' }}</button>
              <button class="mini-btn" @click.stop="openTerm(h)">⌨ 终端</button>
            </div>
          </template>

          <div v-else class="hc-offline">
            <p>{{ h.credReady ? (h.error || '等待首个探测周期…') : `待配置凭据：${h.note || '在监控设置中添加密钥或密码后自动开始采集'}` }}</p>
            <button v-if="h.credReady" class="mini-btn" @click.stop="openTerm(h)">⌨ 仍要连接</button>
          </div>
        </article>
      </div>

      <!-- 内联详情 -->
      <MonitorDetail
        v-if="selectedHost"
        :key="selectedHost.id"
        :host="selectedHost"
        :thresholds="thresholds"
        @term="openTerm(selectedHost)"
        @close="selectedId = ''"
      />
      <div v-if="selectedHost" style="height: 8px" />
    </template>

    <!-- 设置弹窗 -->
    <MonitorSettings :open="settingsOpen" @close="settingsOpen = false" @saved="onSaved" />
    <!-- 终端抽屉 -->
    <MonitorTerm v-if="termHost" :host-id="termHost.id" :host-name="termHost.name" @close="termHost = null" />
  </div>
</template>

<script>
export default { name: 'MonitorView' }
</script>

<style>
/* @property 供仪表环数值过渡（全局 at-rule） */
@property --v {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}
</style>

<style scoped>
.grow { flex: 1; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.sub { color: var(--text-2); font-size: 12.5px; }

/* ===== 登录 ===== */
.mon-login-mask { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; background: var(--bg); }
.mon-login { width: 360px; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-hover); padding: 32px 28px; }
.mon-login h1 { margin: 0 0 4px; font-size: 20px; }
.mon-login p { margin: 0 0 16px; color: var(--text-2); font-size: 13.5px; }
.mon-login input { width: 100%; font: inherit; font-size: 13.5px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 7px 10px; outline: none; margin-bottom: 6px; }
.mon-login input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.login-err { color: var(--red); font-size: 13px; min-height: 20px; margin: 2px 0 8px !important; }
.login-btn { width: 100%; padding: 8px; font-size: 14.5px; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; cursor: pointer; }
.login-btn:hover { filter: brightness(1.06); }
.login-btn:disabled { opacity: 0.6; cursor: default; }

/* ===== 告警横幅 ===== */
.alert-banner { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 6px; }
.alert-item { display: flex; align-items: center; gap: 10px; background: var(--bg-soft); border: 1px solid color-mix(in srgb, var(--red) 35%, var(--border)); border-left: 3px solid var(--red); border-radius: 10px; padding: 8px 14px; }
.alert-item.warn { border-color: color-mix(in srgb, var(--amber) 40%, var(--border)); border-left-color: var(--amber); }
.alert-item b { font-size: 13.5px; }
.alert-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); flex: none; animation: monPulse 2s ease-in-out infinite; }
.alert-item.warn .alert-dot { background: var(--amber); }

/* ===== 工具行 ===== */
.mon-toolbar { display: flex; align-items: baseline; gap: 10px; margin: 10px 0 14px; flex-wrap: wrap; }
.mon-toolbar h2 { font-size: 16px; margin: 0; font-weight: 600; }
.ghost-btn { border: 1px solid var(--border); background: var(--bg-soft); color: var(--text); border-radius: 8px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
.ghost-btn:hover { border-color: var(--accent); color: var(--accent); }
.mon-empty { color: var(--text-2); font-size: 13.5px; background: var(--bg-soft); border: 1px dashed var(--border); border-radius: 12px; padding: 28px; text-align: center; }

/* ===== 主机卡片 ===== */
.host-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 14px; align-items: stretch; }
.host-card {
  --net: var(--accent);
  position: relative;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 14px 16px 12px;
  cursor: pointer;
  overflow: hidden;
  transition: transform 0.16s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.16s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.16s;
}
.host-card::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; width: 3px; border-radius: 0 3px 3px 0; background: var(--net); }
.host-card.public { --net: var(--amber); }
.host-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); border-color: color-mix(in srgb, var(--net) 35%, var(--border)); }
.host-card.selected { border-color: var(--net); box-shadow: 0 0 0 1px var(--net), var(--shadow-hover); }
.host-card.offline { --net: var(--gray); cursor: default; }
.host-card.offline:hover { transform: none; }

.hc-top { display: flex; align-items: center; gap: 8px; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.status-dot.ok { background: var(--green); }
.status-dot.off { background: var(--gray); }
.status-dot.err { background: var(--red); animation: monPulse 2s ease-in-out infinite; }
.hc-name { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-chip { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; background: var(--accent-soft); color: var(--accent); flex: none; }
.env-chip.public { background: var(--amber-soft); color: var(--amber); }
.hc-addr { color: var(--text-2); font-size: 12px; font-family: var(--mono); flex: none; }
.hc-os { color: var(--text-2); font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 19px; }

.hc-main { display: flex; align-items: center; gap: 14px; margin: 12px 0 10px; }
.gauges { display: flex; gap: 14px; }
.gauge {
  --v: 0;
  width: 64px;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  transition: --v 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.gauge::before {
  content: '';
  width: 52px; height: 52px; border-radius: 50%;
  background: conic-gradient(var(--gc, var(--accent)) calc(var(--v) * 1%), var(--bg-hover) 0);
  display: block;
  position: relative;
}
.gauge { position: relative; }
.gauge::after {
  content: '';
  position: absolute; top: 7px; left: 50%; transform: translateX(-50%);
  width: 38px; height: 38px; border-radius: 50%;
  background: var(--bg-soft);
}
.gauge .g-val {
  position: absolute; top: 19px; left: 0; right: 0;
  text-align: center;
  font-size: 12.5px; font-weight: 600; font-family: var(--mono); color: var(--text);
  z-index: 1;
}
.gauge .g-val i { font-style: normal; font-size: 9px; color: var(--text-2); }
.gauge .g-cap { font-size: 11px; color: var(--text-2); }
.gauge.warn::before { --gc: var(--amber); }
.gauge.crit::before { --gc: var(--red); }

.hc-stats {
  margin-left: auto;
  display: flex; flex-direction: column; gap: 4px;
  border-left: 1px dashed var(--border);
  padding-left: 14px;
  min-width: 128px;
}
.hc-stats > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.hc-stats span { font-size: 11.5px; color: var(--text-2); flex: none; }
.hc-stats b { font-size: 12.5px; font-family: var(--mono); font-weight: 600; text-align: right; white-space: nowrap; }
.hc-stats b i { font-style: normal; font-weight: 400; color: var(--text-2); font-size: 11px; }

.hc-foot { display: flex; align-items: center; gap: 8px; padding-top: 9px; border-top: 1px dashed var(--border); }
.hc-foot .hint { color: var(--text-2); font-size: 12px; }
.mini-btn { border: 1px solid var(--border); background: var(--bg-soft); border-radius: 6px; padding: 2px 10px; font-size: 12.5px; cursor: pointer; color: var(--text-2); transition: border-color 0.15s ease, color 0.15s ease; }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }

.hc-offline { padding: 10px 0 6px; }
.hc-offline p { margin: 0 0 8px; color: var(--text-2); font-size: 12.5px; line-height: 1.5; word-break: break-all; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

@keyframes monPulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--red, #cf222e) 45%, transparent); }
  50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--red, #cf222e) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .status-dot.err, .alert-dot { animation: none; }
  .host-card, .gauge { transition: none; }
}
@media (max-width: 640px) {
  .host-grid { grid-template-columns: 1fr; }
  .hc-main { flex-wrap: wrap; }
  .hc-stats { border-left: 0; padding-left: 0; margin-left: 0; width: 100%; flex-direction: row; justify-content: space-between; }
}
</style>
