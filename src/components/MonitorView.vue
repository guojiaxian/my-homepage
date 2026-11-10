<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { monApi, fmtMbs, fmtPct, fmtUptime } from '../lib/monitor-api.js'
import MonitorDetail from './MonitorDetail.vue'
import MonitorSettings from './MonitorSettings.vue'
import MonitorHostEdit from './MonitorHostEdit.vue'
import MonitorTerm from './MonitorTerm.vue'
import MonitorBatchTerm from './MonitorBatchTerm.vue'
import PageHero from './PageHero.vue'

/* active：是否为当前顶层视图（App.vue v-show 常驻，由父级告知）。
   authed：全站登录门状态（App.vue 持有；401 时向上抛 unauth，由父级展示全站登录层）。
   v-if/v-else 分支会让 <KeepAlive> 自身被销毁重建、缓存失效，故改用 v-show + active 自管轮询。 */
const props = defineProps({
  active: { type: Boolean, default: false },
  authed: { type: Boolean, default: false },
  /* 设置弹窗由 App.vue 顶栏常驻齿轮统一控制（与应用中心复用同一入口） */
  settingsOpen: { type: Boolean, default: false },
})
const emit = defineEmits(['unauth', 'update:settingsOpen'])

/* ---------- 状态 ---------- */
const summary = ref(null)
const loadErr = ref('')
const selectedId = ref('')
/* 终端页签：关闭抽屉仅隐藏，多会话并行保留（最多 8 个，同一主机可开多个，LRU 淘汰最久未用） */
const TERM_TABS_MAX = 8
const termTabs = ref([]) // [{ key, hostId, name, ordinal }]，最后一项为最近使用
const termActive = ref('') // 当前页签 key
const termOpen = ref(false)
const termStatus = reactive({}) // key -> '' | 'ok' | 'bad'（页签状态点）
let termSeq = 0
/* 同一主机出现多个会话时，页签名追加稳定序号（落库在 ordinal，不随切换重排） */
const termTabsView = computed(() => {
  const counts = {}
  for (const t of termTabs.value) counts[t.hostId] = (counts[t.hostId] || 0) + 1
  return termTabs.value.map((t) => ({
    ...t,
    label: counts[t.hostId] > 1 ? `${t.name} #${t.ordinal}` : t.name,
  }))
})
const batchPickerOpen = ref(false)
const batchOpen = ref(false)
const batchSel = reactive(new Set())
const batchHosts = ref([])
function toggleBatchSel(id) {
  if (batchSel.has(id)) { batchSel.delete(id); return }
  if (batchSel.size >= 6) { alert('批量终端最多支持 6 台'); return }
  batchSel.add(id)
}
function openBatch() {
  if (!batchSel.size) return
  batchHosts.value = hosts.value.filter((h) => batchSel.has(h.id)).map((h) => ({ id: h.id, name: h.name }))
  batchPickerOpen.value = false
  batchOpen.value = true
}

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

/* 主机卡列数随台数自适应：在 2..5 列里选「行数最少 → 末行空位最少 → 列数少（卡更宽）」的组合，
   保证整行排满不塌空。实测：1→1 2→2 3→3 4→4 5→5 6→3(2行) 7→4 8→4 9→5 10→5 11→4 12→4 15→5 16→4 24→5 */
const hostCols = computed(() => {
  const n = hosts.value.length
  if (n <= 1) return n || 4
  let best = 4, bestScore = Infinity
  for (let c = 2; c <= 5; c++) {
    const score = Math.ceil(n / c) * 100 + (((c - (n % c)) % c) * 10) + c
    if (score < bestScore) { bestScore = score; best = c }
  }
  return best
})

/* ---------- 数据 ---------- */
async function refresh() {
  if (document.hidden || !props.authed) return
  try {
    summary.value = await monApi('/api/monitor/summary')
    loadErr.value = ''
  } catch (e) {
    if (e.authRequired) { emit('unauth'); stopPoll() }
    /* 其余错误静默，下轮重试 */
  }
}
async function boot() {
  try {
    summary.value = await monApi('/api/monitor/summary')
    loadErr.value = ''
    monApi('/api/monitor/config').then((c) => { thresholds.value = c.thresholds || {} }).catch(() => {})
    startPoll()
  } catch (e) {
    if (e.authRequired) emit('unauth')
    else loadErr.value = e.message
  }
}
function startPoll() {
  stopPoll()
  pollTimer = setInterval(refresh, 5_000)
  refresh()
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

/* 视图激活且全站已鉴权时启动（首次 boot / 恢复轮询），离开或掉鉴权时停止 */
watch(
  () => props.active && props.authed,
  (v) => {
    if (v) {
      if (!started) { started = true; boot() }
      else startPoll()
    } else {
      stopPoll()
    }
  },
  { immediate: true },
)

/* ---------- 交互 ---------- */
function toggleDetail(h) {
  selectedId.value = selectedId.value === h.id ? '' : h.id
}
function openTerm(h, forceNew = false) {
  // 默认切到该主机最近使用的会话；要再开一个用页签栏「＋ 新会话」
  if (!forceNew) {
    for (let i = termTabs.value.length - 1; i >= 0; i--) {
      if (termTabs.value[i].hostId === h.id) { switchTerm(termTabs.value[i].key); return }
    }
  }
  // 超出上限先淘汰最久未使用且非当前页签的会话
  while (termTabs.value.length >= TERM_TABS_MAX) {
    const victim = termTabs.value.find((t) => t.key !== termActive.value)
    if (!victim) break
    endTerm(victim.key)
  }
  const ordinal = Math.max(0, ...termTabs.value.filter((t) => t.hostId === h.id).map((t) => t.ordinal)) + 1
  const key = `${h.id}:${++termSeq}`
  termTabs.value.push({ key, hostId: h.id, name: h.name || h.id, ordinal })
  termActive.value = key
  termOpen.value = true
}
/* 为当前页签的主机再开一个独立会话 */
function newTermForActive() {
  const cur = termTabs.value.find((t) => t.key === termActive.value)
  if (!cur) return
  const h = hosts.value.find((x) => x.id === cur.hostId) || { id: cur.hostId, name: cur.name }
  openTerm(h, true)
}
function switchTerm(key) {
  const i = termTabs.value.findIndex((t) => t.key === key)
  if (i < 0) return
  const [t] = termTabs.value.splice(i, 1)
  termTabs.value.push(t) // 最近使用排到最后，淘汰时优先释放最久未用
  termActive.value = key
  termOpen.value = true
}
function endTerm(key) {
  const i = termTabs.value.findIndex((t) => t.key === key)
  if (i < 0) return
  termTabs.value.splice(i, 1)
  delete termStatus[key]
  if (termActive.value !== key) return
  const last = termTabs.value[termTabs.value.length - 1]
  if (last) termActive.value = last.key
  else { termActive.value = ''; termOpen.value = false }
}
function onTermStatus(key, cls) { termStatus[key] = cls || '' }
function onSaved() { refresh() }

/* ---------- 详情页 ⚙：直连编辑单主机 ----------
   拉全量配置 → 深拷贝出目标主机 → 弹窗编辑 → 保存时 PUT 整份配置（其余段原样带回） */
const hostEdit = reactive({ open: false, host: null, cfg: null, saving: false, err: '' })
async function openDirectEdit(h) {
  hostEdit.err = ''
  try {
    const data = JSON.parse(JSON.stringify(await monApi('/api/monitor/config')))
    const target = (data.hosts || []).find((x) => x.id === h.id)
    if (!target) { alert(`配置中未找到主机 ${h.id}`); return }
    hostEdit.cfg = data
    hostEdit.host = target
    hostEdit.open = true
  } catch (e) { alert('加载配置失败：' + e.message) }
}
async function saveDirectEdit() {
  const c = hostEdit.cfg
  if (!c) { hostEdit.open = false; return }
  hostEdit.saving = true
  hostEdit.err = ''
  try {
    await monApi('/api/monitor/config', {
      method: 'PUT',
      body: {
        hosts: c.hosts,
        trackedDirs: c.trackedDirs,
        thresholds: c.thresholds,
        collect: c.collect,
        terminal: c.terminal,
        webhookUrl: c.webhookUrl?.trim() || '',
      },
    })
    hostEdit.open = false
    onSaved()
    /* 阈值可能在本次保存中被修改，同步刷新图表阈值参考线 */
    monApi('/api/monitor/config').then((x) => { thresholds.value = x.thresholds || {} }).catch(() => {})
  } catch (e) {
    hostEdit.err = '保存失败：' + e.message
  } finally { hostEdit.saving = false }
}

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
function barWidth(v) {
  const x = Number(v)
  return `${isFinite(x) ? Math.max(0, Math.min(100, x)) : 0}%`
}
function dirCount(h) { return h.snap?.dirs?.length || 0 }
</script>

<template>
  <div v-show="active">
    <!-- 与应用中心共用同一页头组件，切换时标题/统计区位置完全一致 -->
    <PageHero title="监控中心" subtitle="本机与远程服务器实时指标 · 每 5 秒自动刷新 · 点击卡片查看详情并进入终端">
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
    </PageHero>

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
        <button class="ghost-btn" @click="batchPickerOpen = true">批量终端</button>
      </div>

      <div v-if="!hosts.length" class="mon-empty">还没有纳管主机，点击顶栏 ⚙ 添加。</div>

      <div v-else class="host-grid" :class="'c' + hostCols">
        <article
          v-for="h in hosts"
          :key="h.id"
          class="host-card"
          :class="{ selected: selectedId === h.id, offline: !h.online }"
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
            <div class="hc-metrics">
              <div v-for="g in gauges(h)" :key="g.cap" class="hm" :class="gaugeCls(g.v)" :title="g.title || g.cap">
                <span class="hm-label">{{ g.cap }}</span>
                <span class="hm-val">{{ fmtPct(g.v) }}<i>%</i></span>
                <span class="hm-bar"><i :style="{ width: barWidth(g.v) }" /></span>
              </div>
            </div>
            <div class="hc-line">
              <span title="1 分钟负载 / 核数"><i>负载</i><b>{{ h.snap.cpu?.load1 ?? '-' }}<em>/{{ h.snap.cpu?.loadPerCore ?? '-' }}核</em></b></span>
              <span title="出 / 入流量 Mbps"><i>网络</i><b>↑{{ fmtMbs(h.snap.net?.outMbs) }}<em>↓{{ fmtMbs(h.snap.net?.inMbs) }}</em></b></span>
              <span title="运行时长"><i>运行</i><b>{{ fmtUptime(h.snap.uptimeSec) }}</b></span>
            </div>
            <div class="hc-foot">
              <span class="hint">跟踪 {{ dirCount(h) }} 目录<template v-if="h.snap.containersCount"> · 容器 {{ h.snap.containersCount }}</template></span>
              <span class="grow" />
              <button class="mini-btn" @click.stop="toggleDetail(h)">{{ selectedId === h.id ? '收起' : '详情' }}</button>
              <button class="mini-btn" @click.stop="openTerm(h)">终端</button>
            </div>
          </template>

          <div v-else class="hc-offline">
            <p>{{ h.credReady ? (h.error || '等待首个探测周期…') : `待配置凭据：${h.note || '在监控设置中添加密钥或密码后自动开始采集'}` }}</p>
            <button v-if="h.credReady" class="mini-btn" @click.stop="openTerm(h)">仍要连接</button>
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
        @edit="openDirectEdit(selectedHost)"
      />
      <div v-if="selectedHost" style="height: 8px" />

    <!-- 批量终端主机多选器 -->
    <div v-if="batchPickerOpen" class="batch-picker-mask" @click.self="batchPickerOpen = false">
      <div class="batch-picker" role="dialog" aria-label="批量终端选择主机">
        <div class="bp-head">
          <b>批量终端 · 选择主机</b>
          <span class="sub">最多 6 台，命令将同时下发到每个窗格</span>
        </div>
        <div class="bp-list">
          <label
            v-for="h in hosts.filter((x) => x.credReady)"
            :key="h.id"
            class="bp-row"
            :class="{ on: batchSel.has(h.id), dis: !batchSel.has(h.id) && batchSel.size >= 6 }"
          >
            <input
              type="checkbox"
              :checked="batchSel.has(h.id)"
              :disabled="!batchSel.has(h.id) && batchSel.size >= 6"
              @change="toggleBatchSel(h.id)"
            />
            <span class="bp-name">{{ h.name }}</span>
            <span class="bp-meta"><i class="bp-dot" :class="{ on: h.online }" />{{ h.address }} · {{ h.online ? '在线' : '离线' }}</span>
          </label>
        </div>
        <div class="bp-foot">
          <span class="sub">已选 <b>{{ batchSel.size }}</b>/6</span>
          <span class="grow" />
          <button class="ghost-btn" @click="batchPickerOpen = false">取消</button>
          <button class="bp-primary" :disabled="!batchSel.size" @click="openBatch">打开批量终端（{{ batchSel.size }}）</button>
        </div>
      </div>
    </div>

    <!-- 批量终端 -->
    <MonitorBatchTerm v-if="batchOpen" :hosts="batchHosts" @close="batchOpen = false" />

    <!-- 设置弹窗（入口在顶栏常驻齿轮） -->
    <MonitorSettings :open="settingsOpen" @close="emit('update:settingsOpen', false)" @saved="onSaved" />
    <!-- 详情页 ⚙ 直连主机编辑弹窗（direct 模式：弹窗内「保存」直接 PUT 配置） -->
    <MonitorHostEdit
      :open="hostEdit.open"
      :host="hostEdit.host || { type: 'ssh' }"
      :direct="true"
      :saving="hostEdit.saving"
      :err="hostEdit.err"
      @close="hostEdit.open = false"
      @save="saveDirectEdit"
      @saved="onSaved"
    />
    <!-- 终端抽屉：每个会话一个常驻实例（同一主机可多个），最多 8 个（LRU） -->
    <MonitorTerm
      v-for="t in termTabsView"
      :key="t.key"
      :session-key="t.key"
      :host-id="t.hostId"
      :host-name="t.name"
      :open="termOpen && termActive === t.key"
      :tabs="termTabsView"
      :active-id="termActive"
      :statuses="termStatus"
      @close="termOpen = false"
      @switch="switchTerm"
      @end="endTerm"
      @new="newTermForActive"
      @status="onTermStatus"
    />
  </div>
</template>

<script>
export default { name: 'MonitorView' }
</script>

<style scoped>
.grow { flex: 1; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.sub { color: var(--text-2); font-size: 12.5px; }

/* ===== 登录 ===== */

/* ===== 告警横幅 ===== */
.alert-banner { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 6px; }
.alert-item { display: flex; align-items: center; gap: 10px; background: var(--bg-soft); border: 1px solid color-mix(in srgb, var(--red) 35%, var(--border)); border-left: 3px solid var(--red); border-radius: 10px; padding: 8px 14px; }
.alert-item.warn { border-color: color-mix(in srgb, var(--amber) 40%, var(--border)); border-left-color: var(--amber); }
.alert-item b { font-size: 13.5px; }
.alert-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); flex: none; animation: monPulse 2s ease-in-out infinite; }
.alert-item.warn .alert-dot { background: var(--amber); }

/* ===== 工具行 ===== */
.mon-toolbar { display: flex; align-items: center; gap: 10px; margin: 8px 0 20px; flex-wrap: wrap; }
.mon-toolbar h2 { font-size: 16px; margin: 0; font-weight: 600; }
.ghost-btn {
  border: 0; background: var(--accent-soft); color: var(--accent);
  border-radius: 999px; padding: 6px 16px; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.ghost-btn:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: 0 2px 10px rgb(37 99 235 / 0.18); }
.mon-empty { color: var(--text-2); font-size: 13.5px; background: var(--bg-soft); border: 1px dashed var(--border); border-radius: 12px; padding: 28px; text-align: center; }

/* ===== 主机卡片（列数随台数自适应，优先排满整行：.c1-.c5 由 hostCols 计算） ===== */
.host-grid { display: grid; gap: 12px; align-items: stretch; }
.host-grid.c1 { grid-template-columns: 1fr; }
.host-grid.c2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.host-grid.c3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.host-grid.c4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.host-grid.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.host-card {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 12px 14px;
  cursor: pointer;
  transition: transform 0.16s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.16s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.16s;
}
.host-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.host-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow-hover); }
.host-card.offline { cursor: default; }
.host-card.offline:hover { transform: none; }

.hc-top { display: flex; align-items: center; gap: 8px; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.status-dot.ok { background: var(--green); }
.status-dot.off { background: var(--gray); }
.status-dot.err { background: var(--red); animation: monPulse 2s ease-in-out infinite; }
.hc-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-chip { font-size: 11px; border-radius: 999px; padding: 1px 7px; background: var(--accent-soft); color: var(--accent); flex: none; }
.env-chip.public { background: var(--amber-soft); color: var(--amber); }
.hc-addr { color: var(--text-2); font-size: 11px; font-family: var(--mono); flex: none; }
.hc-os { color: var(--text-2); font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 19px; }

/* 三列大数字 + 迷你进度条（替代原 conic 圆环：数字放大到页首层级，一眼可读） */
.hc-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 11px 0 10px; }
.hm { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hm-label { font-size: 11px; color: var(--text-2); }
.hm-val { font-size: 21px; font-weight: 600; font-family: var(--mono); line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.hm-val i { font-style: normal; font-size: 11.5px; font-weight: 400; color: var(--text-2); margin-left: 1px; }
.hm-bar { height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; margin-top: 2px; }
.hm-bar i { display: block; height: 100%; border-radius: 999px; background: var(--green); transition: width 0.5s cubic-bezier(0.2, 0.8, 0.2, 1); }
.hm.warn .hm-bar i { background: var(--amber); }
.hm.crit .hm-bar i { background: var(--red); }
.hm.warn .hm-val { color: var(--amber); }
.hm.crit .hm-val { color: var(--red); }

/* 负载 / 网络 / 运行：单行弱信息 */
.hc-line { display: flex; align-items: baseline; gap: 3px 10px; flex-wrap: wrap; margin-bottom: 9px; }
.hc-line > span { display: flex; align-items: baseline; gap: 3px; min-width: 0; }
.hc-line i { font-style: normal; color: var(--text-2); font-size: 11px; }
.hc-line b { font-family: var(--mono); font-size: 12px; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hc-line em { font-style: normal; font-weight: 400; color: var(--text-2); font-size: 10.5px; }

.hc-foot { display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.hc-foot .hint { color: var(--text-2); font-size: 12px; }
.mini-btn {
  border: 0; background: var(--bg-hover); color: var(--text-2);
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.mini-btn:hover { color: var(--accent); background: var(--accent-soft); }

.hc-offline { padding: 10px 0 6px; }
.hc-offline p { margin: 0 0 8px; color: var(--text-2); font-size: 12.5px; line-height: 1.5; word-break: break-all; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

/* ===== 批量终端主机选择弹窗 ===== */
.batch-picker-mask {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: center; justify-content: center;
  padding: 24px 16px;
  background: rgb(16 24 40 / 0.45);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.batch-picker {
  width: 460px; max-width: 100%; max-height: calc(100vh - 80px);
  display: flex; flex-direction: column;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-hover);
  overflow: hidden;
}
.bp-head { display: flex; flex-direction: column; gap: 3px; padding: 16px 18px 12px; flex: none; }
.bp-head b { font-size: 15.5px; }
.bp-head .sub { font-size: 12.5px; }
.bp-list { display: flex; flex-direction: column; gap: 6px; padding: 0 10px 12px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.bp-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.bp-row:hover { border-color: var(--border-strong); background: var(--bg-hover); }
.bp-row.on { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
.bp-row.dis { opacity: 0.5; cursor: not-allowed; }
.bp-row.dis:hover { border-color: var(--border); background: var(--bg-soft); }
.bp-row input { width: 15px; height: 15px; margin: 0; flex: none; accent-color: var(--accent); cursor: inherit; }
.bp-name { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-meta { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex: none; color: var(--text-2); font-size: 11.5px; font-family: var(--mono); }
.bp-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gray); flex: none; }
.bp-dot.on { background: var(--green); }
.bp-foot { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--border); flex: none; }
.bp-foot .sub { font-size: 12.5px; }
.bp-foot .sub b { color: var(--text); }
.bp-primary {
  border: 0; background: var(--accent); color: #fff;
  border-radius: 999px; padding: 7px 18px;
  font-size: 13px; font-weight: 500; cursor: pointer;
  transition: filter 0.15s ease, opacity 0.15s ease;
}
.bp-primary:hover:not(:disabled) { filter: brightness(1.06); }
.bp-primary:disabled { opacity: 0.5; cursor: default; }

@keyframes monPulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--red, #cf222e) 45%, transparent); }
  50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--red, #cf222e) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .status-dot.err, .alert-dot { animation: none; }
  .host-card, .hm-bar i { transition: none; }
}
@media (max-width: 1200px) {
  .host-grid.c4, .host-grid.c5 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 820px) {
  .host-grid.c3, .host-grid.c4, .host-grid.c5 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .host-grid { grid-template-columns: 1fr !important; }
}
</style>
