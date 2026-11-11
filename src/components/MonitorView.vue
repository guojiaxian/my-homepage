<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
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
/* 终端多窗格：抽屉顶部主机名列表点击即新增窗格（同一主机可多开），窗格按点击
   顺序 3 列排布，满 3 列后纵向新增（第 4 个在第 3 列下方）；关闭抽屉仅隐藏，
   全部窗格与 shell 现场保留，重开不重连。上限 6 个窗格。 */
const PANES_MAX = 6
const termPanes = ref([]) // [{ key, hostId, name, ordinal }]，顺序 = 点击顺序
const termOpen = ref(false)
const termFull = ref(false)
const multiInput = ref(false) // 多端输入：任一窗格键入同步到其他窗格
const termStatus = reactive({}) // key -> '' | 'ok' | 'bad'（窗格状态点）
const paneTip = ref('')
let termSeq = 0
const paneRefs = new Map() // key -> MonitorTerm 暴露的 { send, focus, refit }
function setPaneRef(key, el) { if (el) paneRefs.set(key, el); else paneRefs.delete(key) }
const paneRows = computed(() => Math.max(1, Math.ceil(termPanes.value.length / 3)))
const paneCols = computed(() => (termPanes.value.length === 2 ? 2 : Math.min(3, Math.max(1, termPanes.value.length))))
const paneGridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${paneCols.value}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${paneRows.value}, minmax(0, 1fr))`,
}))
/* 窗格落位：1-3 号横向一行；4-6 号纵向新增——4 号在第 3 列下方，5/6 依次往左 */
function panePos(i) {
  if (i < 3) return { gridRow: '1', gridColumn: String(i + 1) }
  return { gridRow: '2', gridColumn: String(3 - (i - 3)) }
}
/* 新窗格滑入方向：第一行从右侧滑入，第二行从下方滑入 */
const justAdded = ref('') // key
const justAddedDir = ref('right')
let justAddedTimer = null
function markJustAdded(key, i) {
  justAdded.value = key
  justAddedDir.value = i < 3 ? 'right' : 'bottom'
  clearTimeout(justAddedTimer)
  justAddedTimer = setTimeout(() => { justAdded.value = '' }, 450)
}
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
  // 主机卡「终端」入口：该主机已有窗格则聚焦它（现场保留），否则新建窗格
  if (!forceNew) {
    const ex = [...termPanes.value].reverse().find((t) => t.hostId === h.id)
    if (ex) { termOpen.value = true; focusPane(ex.key); return }
  }
  addPane(h)
}
/* 抽屉顶部主机名列表：点击即新增窗格（同一主机可多开） */
function addPane(h) {
  if (termPanes.value.length >= PANES_MAX) { paneTip.value = '最多支持 6 个终端窗格'; return }
  if (!termPanes.value.length) paneTip.value = ''
  const ordinal = Math.max(0, ...termPanes.value.filter((t) => t.hostId === h.id).map((t) => t.ordinal)) + 1
  const key = `${h.id}:${++termSeq}`
  flipLayout(() => {
    termPanes.value.push({ key, hostId: h.id, name: h.name || h.id, ordinal })
  })
  markJustAdded(key, termPanes.value.length - 1)
  termOpen.value = true
  paneTip.value = ''
}
function endPane(key) {
  let idx = -1
  flipLayout(() => {
    const i = termPanes.value.findIndex((t) => t.key === key)
    if (i >= 0) { idx = i; termPanes.value.splice(i, 1) }
    delete termStatus[key]
  })
  if (idx < 0) return
  const survivor = termPanes.value[Math.min(idx, termPanes.value.length - 1)] // 聚焦相邻幸存窗格而非已删除的
  if (survivor) focusPane(survivor.key)
  if (!termPanes.value.length) termOpen.value = false // 全部关闭时收起抽屉
}
function focusPane(key) { const r = paneRefs.get(key); r && r.focus() }
function hideDrawer() { termOpen.value = false } // 仅隐藏：全部窗格与 shell 现场保留
/* ✕ 关闭确认：清空动作不可恢复，弹窗确认后执行；遮罩/ESC 退出仍保留现场 */
const closeConfirm = ref(false)
function askCloseAll() { closeConfirm.value = true }
function confirmCloseAll() {
  closeConfirm.value = false
  clearTimeout(justAddedTimer)
  justAdded.value = ''
  for (const k of Object.keys(termStatus)) delete termStatus[k]
  termPanes.value = [] // 卸载全部 MonitorTerm → 各自 onBeforeUnmount 关 WS / 释放 xterm
  termOpen.value = false
  paneTip.value = ''
}
function onTermStatus(key, cls) { termStatus[key] = cls || '' }
/* 多端输入：任一窗格键入同步到其他窗格 */
function onPaneInput(from, d) {
  if (!multiInput.value || !d) return
  for (const [key, r] of paneRefs) { if (key !== from) r.send(d) }
}
/* 全屏：铺满视口，全部窗格重排 */
function toggleTermFull() {
  termFull.value = !termFull.value
  setTimeout(refitAll, 80)
}
function refitAll() { for (const r of paneRefs.values()) r.refit() }
/* ESC：全屏时还原窗口，否则收起抽屉（窗格保留） */
function onEsc(e) {
  if (e.key !== 'Escape') return // 只拦截 Esc；其余按键（含命令字符）必须放行
  if (!termOpen.value) return
  e.preventDefault(); e.stopPropagation()
  if (closeConfirm.value) { closeConfirm.value = false; return } // 确认框打开时 ESC 只撤确认
  if (termFull.value) toggleTermFull(); else hideDrawer('esc')
}
window.addEventListener('keydown', onEsc, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc, true))
/* 滚轮滚动链守卫：终端区滚到头后浏览器会把滚动交给底层文档（背后页面跟着滚），
   在抽屉与遮罩上直接消费 wheel 默认行为。xterm 自身的回滚在其内部监听里已完成
   （冒泡阶段先于本守卫），不受影响。 */
const termMaskEl = ref(null), termDrawerEl = ref(null)
function guardWheel(e) { e.preventDefault() }
onMounted(() => {
  termMaskEl.value?.addEventListener('wheel', guardWheel, { passive: false })
  termDrawerEl.value?.addEventListener('wheel', guardWheel, { passive: false })
})
onBeforeUnmount(() => {
  termMaskEl.value?.removeEventListener('wheel', guardWheel)
  termDrawerEl.value?.removeEventListener('wheel', guardWheel)
})
function popoutPane(key, hostId) {
  flipLayout(() => {
    const i = termPanes.value.findIndex((t) => t.key === key)
    if (i >= 0) termPanes.value.splice(i, 1)
    delete termStatus[key]
  })
  /* 子端只 emit 交回窗格生命周期；window.open 统一由父级调用（双端都开会变成双窗口） */
  window.open(`/monitor/terminal.html?host=${encodeURIComponent(hostId)}`, '_blank', 'width=980,height=640')
}
/* FLIP：布局变更前记录旧位置，更新后反向位移再过渡回原位，保证移动/缩放平滑 */
function flipLayout(mut) {
  const before = new Map()
  for (const [key, r] of paneRefs) {
    const el = r && r.el
    if (el) before.set(key, el.getBoundingClientRect())
  }
  mut()
  nextTick(() => {
    for (const [key, r] of paneRefs) {
      const el = r && r.el
      const b = before.get(key)
      if (!el || !b) continue
      const a = el.getBoundingClientRect()
      const dx = b.left - a.left
      const dy = b.top - a.top
      if (!dx && !dy) continue
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      el.getBoundingClientRect() // 强制回流
      el.style.transition = 'transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      el.style.transform = ''
      el.addEventListener('transitionend', () => { el.style.transition = ''; el.style.transform = '' }, { once: true })
    }
  })
}
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
  } catch (e) {
    hostEdit.err = '保存失败：' + e.message
  } finally { hostEdit.saving = false }
}

/* ---------- 卡片渲染辅助 ---------- */
/* 归属三类：与应用中心同色（本机蓝 lan / 外机绿 ext / 公网橙 net） */
function hostScope(h) {
  if (h.type === 'local') return 'lan'
  return /公网|public/i.test(h.group || '') ? 'net' : 'ext'
}
const HOST_SCOPE_LABEL = { lan: '本机', ext: '外机', net: '公网' }
function hostScopeLabel(h) { return HOST_SCOPE_LABEL[hostScope(h)] }
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
/* 内存按标称容量显示：/proc/meminfo 的 MemTotal 会扣掉内核保留（32GB 机器常见 ~30GB），
   向上取到常见内存档位，避免把 32GB 显示成 30GB */
const MEM_STEPS = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048]
function nominalMemGb(mb) {
  const gb = mb / 1024
  return MEM_STEPS.find((s) => gb <= s) || Math.ceil(gb / 1024) * 1024
}
/* 主机副标题：核心数 + CPU 型号 · 内存 · 磁盘 · 操作系统 */
function hostSubtitle(h) {
  const s = h.snap
  if (!s) return ''
  const raw = s.os || ''
  const [osPart, cpuRaw] = raw.split(' · ')
  /* 使用采集体提供的真实 CPU 型号（含厂商），只清理 Processor/(R)/@GHz 等噪声 */
  const cpu = (s.cpu?.model || cpuRaw || '')
    .replace(/\s*Processor(\s+series)?\s*$/i, '')
    .replace(/\(R\)|\(TM\)/gi, '')
    .replace(/\s+CPU\s+/i, ' ')
    .replace(/\s*@\s*[\d.]+GHz$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cores = s.cpu?.cores
  const cpuText = cores ? `${cores}核${cpu ? ' ' + cpu : ''}` : cpu
  const mem = s.mem?.totalMb ? `${nominalMemGb(s.mem.totalMb)}GB` : ''
  /* 磁盘按整盘原始容量（/sys/block 扇区）显示，而不是文件系统可用量：
     1TiB 虚拟盘显示 1TB，不再出现 0.9TB；旧数据无 storage 时回退到分区汇总 */
  const rawBytes = Number(s.storage?.totalBytes) || 0
  let disk = ''
  if (rawBytes > 0) {
    const gib = rawBytes / 1073741824
    disk = gib >= 1024 ? `${+((gib / 1024).toFixed(1))}TB` : `${Math.round(gib)}GB`
  } else {
    const diskGb = (s.disks || [])
      .filter((d) => !/^(tmpfs|devtmpfs|overlay|squashfs|iso9660|proc|sysfs)$/i.test(d.type || ''))
      .reduce((a, d) => a + (Number(d.totalGb) || 0), 0)
    disk = diskGb ? (diskGb >= 512 ? `${+((diskGb / 1024).toFixed(1))}TB` : `${Math.round(diskGb)}GB`) : ''
  }
  let osName = osPart || ''
  if (/ky10/i.test(osName)) osName = 'Kylin V10' // 本机 os 字段是内核串，映射为发行版名
  return [cpuText, mem, disk, osName].filter(Boolean).join(' · ')
}
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
        <span class="sub">本机蓝 / 外机绿 / 公网橙 · 点击卡片展开详情</span>
        <span class="grow" />
        <span class="sub num" v-if="summary">更新于 {{ new Date(summary.serverTime).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
      </div>

      <div v-if="!hosts.length" class="mon-empty">还没有纳管主机，点击顶栏 ⚙ 添加。</div>

      <div v-else class="host-grid" :class="'c' + hostCols">
        <article
          v-for="h in hosts"
          :key="h.id"
          class="host-card"
          :class="[hostScope(h), { selected: selectedId === h.id, offline: !h.online }]"
          @click="toggleDetail(h)"
        >
          <div class="hc-top">
            <span class="status-dot" :class="dotCls(h)" :title="h.online ? '在线' : h.error || '待配置'" />
            <span class="hc-name">{{ h.name }}</span>
            <span class="env-chip" :class="hostScope(h)">{{ hostScopeLabel(h) }}</span>
            <span class="grow" />
            <span class="hc-addr">{{ h.address }}</span>
          </div>
          <div class="hc-os" :title="hostSubtitle(h)">{{ hostSubtitle(h) || (h.credReady ? '' : 'SSH 凭据待配置') }}</div>

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
    <!-- 终端抽屉：多窗格布局，关闭仅隐藏（现场保留），重开不重连 -->
    <div ref="termMaskEl" class="mon-term-mask" v-show="termOpen && !termFull" @click="hideDrawer()" />
    <div ref="termDrawerEl" class="mon-term-drawer" v-show="termOpen" :class="{ multi: termPanes.length > 1, full: termFull, w1: termPanes.length === 1, w2: termPanes.length === 2, w3: termPanes.length >= 3 }">
      <div class="mon-term-head">
        <span class="t-title">终端</span>
        <span class="t-multi" :class="{ on: multiInput }" title="任一窗格键入的指令将同步到其他窗格">
          {{ multiInput ? '多端输入：开' : '多端输入：关' }}
        </span>
        <button class="mini-btn" :class="{ on: multiInput }" @click="multiInput = !multiInput">{{ multiInput ? '关闭同步' : '开启同步' }}</button>
        <span class="grow" />
        <button class="mini-btn" @click="toggleTermFull">{{ termFull ? '还原窗口' : '全屏' }}</button>
        <button class="mini-btn" title="关闭并清空全部终端（下次打开为全新会话）" @click="askCloseAll()">✕ 关闭</button>
        <div class="host-chips">
          <span class="chips-hint">点击主机名新增终端窗格（同一主机可多开 · 最多 6 个）：</span>
          <button
            v-for="h in hosts.filter((x) => x.credReady)"
            :key="h.id"
            class="host-chip"
            :class="hostScope(h)"
            :title="`${hostScopeLabel(h)} · ${h.name}（${h.address}）— 新增一个终端窗格`"
            @click="addPane(h)"
          >{{ h.name }}</button>
          <span v-if="paneTip" class="chips-tip">{{ paneTip }}</span>
        </div>
      </div>
      <div class="panes-grid" :style="paneGridStyle">
        <div
          v-for="(t, i) in termPanes"
          :key="t.key"
          class="mtp-wrap"
          :class="[justAdded === t.key ? (justAddedDir === 'bottom' ? 'in-bottom' : 'in-right') : '']"
          :style="panePos(i)"
        >
          <MonitorTerm
            :ref="(el) => setPaneRef(t.key, el)"
            :session-key="t.key"
            :host-id="t.hostId"
            :host-name="t.name"
            :ordinal="t.ordinal"
            :visible="termOpen"
            :broadcast="multiInput"
            @end="endPane"
            @status="onTermStatus"
            @input="onPaneInput($event.from, $event.text)"
            @popout="popoutPane"
          />
        </div>
      </div>
      <!-- ✕ 关闭确认：清空动作不可恢复，先确认再执行（取消 / ESC / 点遮罩均可撤销） -->
      <div v-if="closeConfirm" class="tc-mask" @click.self="closeConfirm = false">
        <div class="tc-box">
          <p class="tc-title">关闭并清空全部终端？</p>
          <p class="tc-desc">将断开当前 {{ termPanes.length }} 个终端会话，下次打开为全新会话。如需保留现场，请点抽屉外空白处或按 ESC 退出。</p>
          <div class="tc-actions">
            <button class="tc-btn" @click="closeConfirm = false">取消</button>
            <button class="tc-btn danger" @click="confirmCloseAll()">关闭并清空</button>
          </div>
        </div>
      </div>
    </div>
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
  display: flex;
  flex-direction: column;
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
/* 归属色边：与应用中心一致（本机蓝 / 外机绿 / 公网橙）；放在 hover/selected 之后确保左色边不被覆盖 */
.host-card { border-left-width: 3px; }
.host-card.lan { border-left-color: var(--accent); }
.host-card.ext { border-left-color: var(--green); }
.host-card.net { border-left-color: var(--amber); }

.hc-top { display: flex; align-items: center; gap: 8px; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.status-dot.ok { background: var(--green); }
.status-dot.off { background: var(--gray); }
.status-dot.err { background: var(--red); animation: monPulse 2s ease-in-out infinite; }
.hc-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-chip { font-size: 11px; border-radius: 999px; padding: 1px 7px; flex: none; }
.env-chip.lan { background: var(--accent-soft); color: var(--accent); }
.env-chip.ext { background: var(--green-soft); color: var(--green); }
.env-chip.net { background: var(--amber-soft); color: var(--amber); }
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
.hc-line { display: flex; align-items: baseline; gap: 3px 10px; flex-wrap: wrap; margin-bottom: 9px; min-height: 38px; align-content: flex-start; }
.hc-line > span { display: flex; align-items: baseline; gap: 3px; min-width: 0; }
.hc-line i { font-style: normal; color: var(--text-2); font-size: 11px; }
.hc-line b { font-family: var(--mono); font-size: 12px; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hc-line em { font-style: normal; font-weight: 400; color: var(--text-2); font-size: 10.5px; }

.hc-foot { display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); margin-top: auto; }
.hc-foot .hint { color: var(--text-2); font-size: 12px; }
.mini-btn {
  border: 0; background: var(--bg-hover); color: var(--text-2);
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.mini-btn:hover { color: var(--accent); background: var(--accent-soft); }

.hc-offline { padding: 10px 0 6px; }

/* ===== 终端多窗格抽屉 ===== */
.mon-term-mask {
  position: fixed; inset: 0; z-index: 55;
  background: rgb(16 24 40 / 0.45);
}
.mon-term-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 60;
  width: min(1440px, 97vw);
  background: var(--bg-soft); border-left: 1px solid var(--border);
  box-shadow: -12px 0 40px rgb(16 24 40 / 0.18);
  display: flex; flex-direction: column; overflow: hidden;
  animation: monTermIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  transition: width 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
/* 渐进宽度：1 格占 1/3 屏、2 格占 2/3 屏、3 格及以上几乎全屏（左侧留遮罩空白可点击退出） */
.mon-term-drawer.w1:not(.full) { width: clamp(420px, 33.33vw, 720px); }
.mon-term-drawer.w2:not(.full) { width: clamp(780px, 66.66vw, 1440px); }
.mon-term-drawer.w3:not(.full) { width: calc(100vw - 56px); }
.mon-term-drawer.full { inset: 0; width: 100vw; height: 100vh; border-left: 0; border-radius: 0; }
.mon-term-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  flex: none; padding: 10px 14px 0;
}
.t-title { font-size: 13.5px; font-weight: 600; color: var(--text); }
/* ✕ 关闭确认框（抽屉内居中模态） */
.tc-mask { position: absolute; inset: 0; z-index: 40; background: rgb(16 24 40 / 0.45); display: flex; align-items: center; justify-content: center; }
.tc-box { width: 400px; max-width: calc(100% - 48px); background: var(--bg-soft); border: 1px solid var(--border); border-radius: 14px; box-shadow: -12px 0 40px rgb(16 24 40 / 0.18), 0 18px 50px rgb(16 24 40 / 0.25); padding: 18px 18px 14px; }
.tc-title { margin: 0 0 6px; font-size: 14.5px; font-weight: 600; color: var(--text); }
.tc-desc { margin: 0 0 14px; font-size: 12.5px; color: var(--text-2); line-height: 1.6; }
.tc-actions { display: flex; justify-content: flex-end; gap: 8px; }
.tc-btn {
  border: 1px solid var(--border-strong); background: var(--bg); color: var(--text);
  border-radius: 999px; padding: 5px 16px; font-size: 12.5px; cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.tc-btn:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.tc-btn.danger { border: 0; background: var(--red); color: #fff; }
.tc-btn.danger:hover { background: color-mix(in srgb, var(--red) 85%, #000); color: #fff; }
.mon-term-drawer :deep(.t-multi) { font-size: 12px; padding: 1px 10px; border-radius: 999px; color: var(--text-2); border: 1px dashed var(--border-strong); }
.mon-term-drawer :deep(.t-multi.on) { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
.mon-term-drawer :deep(.mini-btn.on) { color: var(--accent); background: var(--accent-soft); }
.mon-term-drawer :deep(.host-chips) {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  flex: none; flex-basis: 100%; padding: 6px 0 8px; border-bottom: 1px solid var(--border);
}
.mon-term-drawer :deep(.chips-hint) { font-size: 11.5px; color: var(--text-2); }
.mon-term-drawer :deep(.host-chip) {
  border: 1px solid var(--border-strong); background: var(--bg); color: var(--text);
  border-radius: 999px; padding: 2px 12px; font-size: 12px; cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}
.mon-term-drawer :deep(.host-chip:hover) { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); transform: translateY(-1px); }
/* 主机芯片同样按归属着色；放在基础 hover 之后，ext/net 悬停不会被重置成蓝色 */
.mon-term-drawer :deep(.host-chip.lan) { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); background: var(--accent-soft); }
.mon-term-drawer :deep(.host-chip.ext) { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, var(--border)); background: var(--green-soft); }
.mon-term-drawer :deep(.host-chip.net) { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, var(--border)); background: var(--amber-soft); }
.mon-term-drawer :deep(.chips-tip) { font-size: 11.5px; color: var(--red); }
.mon-term-drawer :deep(.panes-grid) {
  flex: 1; min-height: 0; display: grid; gap: 8px; padding: 8px 8px 8px; background: #0d1117;
  transition: grid-template-rows 300ms cubic-bezier(0.2, 0.8, 0.2, 1), grid-template-columns 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.mon-term-drawer :deep(.mtp-wrap) {
  display: flex; flex-direction: column; min-width: 0; min-height: 0;
  border: 1px solid #30363d; border-radius: 10px; overflow: hidden; background: #0d1117;
  transition: transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@media (prefers-reduced-motion: no-preference) {
  .mon-term-drawer :deep(.mtp-wrap.in-right) { animation: paneInRight 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  .mon-term-drawer :deep(.mtp-wrap.in-bottom) { animation: paneInBottom 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  @keyframes paneInRight { from { transform: translateX(90px); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes paneInBottom { from { transform: translateY(70px); opacity: 0; } to { transform: none; opacity: 1; } }
}
@media (prefers-reduced-motion: reduce) {
  .mon-term-drawer { animation: none !important; }
  .mon-term-drawer :deep(.mtp-wrap.in-right), .mon-term-drawer :deep(.mtp-wrap.in-bottom) { animation: none !important; }
}
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
