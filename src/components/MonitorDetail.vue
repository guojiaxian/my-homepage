<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { monApi, fmtMb, fmtMbs, fmtPct, fmtUptime } from '../lib/monitor-api.js'

const props = defineProps({
  host: { type: Object, required: true }, // summary 里的主机条目（随父级轮询更新）
})
const emit = defineEmits(['term', 'close', 'edit'])

const range = ref('1h')
const hist = ref([])
const dirsList = ref([])
const procsList = ref([])
const procsTotal = ref(0)
const dirMetric = ref('mem')
const dirFilter = ref('')
const compareSet = reactive(new Set())
const seededDirs = new Set() // 已默认勾选过的目录路径：15s 自刷只补勾新增目录，不重置用户手动取消的项
const loading = ref(true)
const err = ref('')

const elCpu = ref(null), elMem = ref(null), elNet = ref(null), elDio = ref(null)
const elDirs = ref(null), elCmp = ref(null)
let charts = null // 动态加载后的 { mod, instances: Map }

const RANGES = [
  { v: '1h', label: '1 小时' },
  { v: '24h', label: '24 小时' },
  { v: '7d', label: '7 天' },
]
const METRICS = [
  { v: 'cpu', label: 'CPU %' },
  { v: 'mem', label: '内存 MB' },
  { v: 'ioR', label: 'IO 读 MB/s' },
  { v: 'ioW', label: 'IO 写 MB/s' },
  { v: 'threads', label: '线程数' },
  { v: 'fds', label: '句柄数' },
]
// API 目录对象字段名与指标 key 的映射
const DIR_FIELD = { cpu: 'cpuPct', mem: 'memMb', ioR: 'ioReadMbs', ioW: 'ioWriteMbs', threads: 'threads', fds: 'fds' }

async function loadCharts() {
  if (charts) return charts
  const mod = await import('../lib/monitor-charts.js')
  charts = { mod, instances: new Map() }
  return charts
}
function inst(key, el) {
  if (!charts.instances.has(key)) charts.instances.set(key, mod().createChart(el))
  return charts.instances.get(key)
}
const mod = () => charts.mod

async function load() {
  err.value = ''
  try {
    const hostId = props.host.id
    const [h, p] = await Promise.all([
      monApi(`/api/monitor/hosts/${encodeURIComponent(hostId)}/history?range=${range.value}`),
      monApi(`/api/monitor/hosts/${encodeURIComponent(hostId)}/procs`),
    ])
    hist.value = h.points || []
    procsList.value = p.procs || []
    procsTotal.value = p.procsTotal || 0
    dirsList.value = p.dirs || []
    /* 目录历史对比默认全选：新目录补勾（首载即全选），用户手动取消的不会被自刷勾回 */
    for (const d of dirsList.value) {
      if (!seededDirs.has(d.path)) { seededDirs.add(d.path); compareSet.add(d.path) }
    }
    loading.value = false
    await renderAll()
  } catch (e) {
    err.value = e.message
    loading.value = false
  }
}

async function renderAll() {
  await loadCharts()
  renderTrends()
  renderDirs()
  await renderCompare()
  window.addEventListener('resize', onResize)
}
function onResize() { if (charts) charts.instances.forEach((c) => c.resize()) }

function pts() { return hist.value || [] }
/* 当前值 / 区间峰值：图头直接展示，解释纵轴为何按峰值自适应 */
const cpuNow = computed(() => (hist.value.length ? hist.value[hist.value.length - 1].cpu : null))
const cpuPeak = computed(() => hist.value.reduce((m, p) => Math.max(m, p.cpu ?? 0), 0))

function renderTrends() {
  const { baseOption, lineSeries, legendStyle, cssVar } = mod()
  const t = (p) => p.t
  /* 纵轴单位：轴名放顶部，避免数值标签加单位后挤压绘图区 */
  const unit = (text) => ({
    name: text,
    nameLocation: 'end',
    nameGap: 8,
    nameTextStyle: { color: cssVar('--text-2'), fontSize: 10, align: 'left' },
  })
  const c = inst('cpu', elCpu.value)
  const cpuBase = baseOption('{value}%', range.value)
  c.setOption({
    ...cpuBase,
    legend: legendStyle(),
    grid: { ...cpuBase.grid, top: 30 },
    tooltip: { ...cpuBase.tooltip, valueFormatter: (v) => (v == null ? '-' : `${v}%`) },
    series: [
      lineSeries('CPU %', pts().map((p) => [t(p), p.cpu]), cssVar('--accent')),
    ],
  }, { notMerge: true })

  const memBase = baseOption('{value}%', range.value)
  inst('mem', elMem.value).setOption({
    ...memBase,
    legend: legendStyle(),
    grid: { ...memBase.grid, top: 30 },
    tooltip: { ...memBase.tooltip, valueFormatter: (v) => (v == null ? '-' : `${v}%`) },
    series: [
      lineSeries('内存 %', pts().map((p) => [t(p), p.mem]), cssVar('--purple')),
    ],
  }, { notMerge: true })

  const netBase = baseOption('{value}', range.value)
  inst('net', elNet.value).setOption({
    ...netBase,
    legend: legendStyle(),
    grid: { ...netBase.grid, top: 30 },
    tooltip: { ...netBase.tooltip, valueFormatter: (v) => (v == null ? '-' : `${v} Mbps`) },
    yAxis: { ...netBase.yAxis, ...unit('Mbps') },
    series: [
      lineSeries('下行 Mbps', pts().map((p) => [t(p), p.netI]), cssVar('--accent')),
      lineSeries('上行 Mbps', pts().map((p) => [t(p), p.netO]), cssVar('--green')),
    ],
  }, { notMerge: true })

  const dioBase = baseOption('{value}', range.value)
  inst('dio', elDio.value).setOption({
    ...dioBase,
    legend: legendStyle(),
    grid: { ...dioBase.grid, top: 30 },
    tooltip: { ...dioBase.tooltip, valueFormatter: (v) => (v == null ? '-' : `${v} MB/s`) },
    yAxis: { ...dioBase.yAxis, ...unit('MB/s') },
    series: [
      lineSeries('读 MB/s', pts().map((p) => [t(p), p.dioR]), cssVar('--teal')),
      lineSeries('写 MB/s', pts().map((p) => [t(p), p.dioW]), cssVar('--amber')),
    ],
  }, { notMerge: true })
}

function renderDirs() {
  if (!dirsList.value.length || !elDirs.value) return // 无目录主机：占位文案已替代图表
  const { hBarOption, cssVar } = mod()
  const field = DIR_FIELD[dirMetric.value] || dirMetric.value
  const top = [...dirsList.value].sort((a, b) => (b[field] || 0) - (a[field] || 0)).slice(0, 10)
  inst('dirs', elDirs.value).setOption(hBarOption(
    top.map((d) => d.name),
    top.map((d) => ({
      value: +(d[field] || 0).toFixed(2),
      dirPath: d.path,
      itemStyle: { color: cssVar('--accent') },
    })),
    { labelWidth: 150 },
  ), { notMerge: true })
  const c = inst('dirs', elDirs.value)
  c.off('click')
  c.on('click', (params) => {
    const dir = params.data && params.data.dirPath
    if (!dir) return
    dirFilter.value = dirFilter.value === dir ? '' : dir
  })
}

async function renderCompare() {
  if (!dirsList.value.length || !elCmp.value) return // 对比框随目录存在与否整体收起
  const { baseOption, lineSeries, legendStyle, cssVar } = mod()
  const dirs = [...compareSet]
  const c = inst('cmp', elCmp.value)
  if (!dirs.length) {
    c.setOption({ ...baseOption('{value}%', range.value), series: [] }, { notMerge: true })
    return
  }
  try {
    const res = await monApi(`/api/monitor/dirs/history?host=${encodeURIComponent(props.host.id)}&range=${range.value}&dirs=${encodeURIComponent(dirs.join('|'))}`)
    const palette = ['--accent', '--purple', '--teal', '--amber', '--green', '--red']
    c.setOption({
      ...baseOption('{value}%', range.value),
      legend: legendStyle(),
      series: Object.entries(res.series).map(([path, rows], i) => lineSeries(
        dirsList.value.find((d) => d.path === path)?.name || path,
        rows.map((r) => [r.t, r.cpu]),
        cssVar(palette[i % palette.length]),
        { noArea: i > 0 },
      )),
    }, { notMerge: true })
  } catch { /* 静默，下一轮刷新 */ }
}

async function toggleCompare(path) {
  if (compareSet.has(path)) compareSet.delete(path)
  else compareSet.add(path)
  await nextTick()
  if (compareSet.size && charts) inst('cmp', elCmp.value).resize() // v-show 刚显示，容器尺寸从 0 恢复
  renderCompare()
}

/* 全选 / 清空（清空不动 seededDirs：自刷不会把勾选强行加回来） */
async function setAllCompare(on) {
  compareSet.clear()
  if (on) for (const d of dirsList.value) { compareSet.add(d.path); seededDirs.add(d.path) }
  await nextTick()
  if (compareSet.size && charts) inst('cmp', elCmp.value).resize()
  renderCompare()
}

/* 进程表排序：默认 CPU% 降序；点击表头切换字段，再点切换方向 */
const PROC_COLS = [
  { key: 'name', label: '程序' },
  { key: 'dirName', label: '归属' },
  { key: 'pid', label: 'PID', num: true },
  { key: 'cpuPct', label: 'CPU%', num: true },
  { key: 'memMb', label: '内存', num: true },
  { key: 'ioReadMbs', label: 'IO读 MB/s', num: true },
  { key: 'ioWriteMbs', label: 'IO写 MB/s', num: true },
  { key: 'threads', label: '线程', num: true },
  { key: 'fds', label: '句柄', num: true },
  { key: 'container', label: '容器' },
  { key: 'cmd', label: '命令行' },
]
const sortKey = ref('cpuPct')
const sortDir = ref(-1)
const NUMERIC_COLS = new Set(PROC_COLS.filter((c) => c.num).map((c) => c.key))
function sortBy(key) {
  if (sortKey.value === key) { sortDir.value = -sortDir.value; return }
  sortKey.value = key
  sortDir.value = NUMERIC_COLS.has(key) ? -1 : 1
}
const filteredProcs = () =>
  procsList.value.filter((p) => !dirFilter.value || p.dir === dirFilter.value)
const sortedProcs = computed(() => {
  const key = sortKey.value
  const dir = sortDir.value
  return [...filteredProcs()].sort((a, b) => {
    const va = a[key]
    const vb = b[key]
    if (va == null && vb == null) return (a.pid || 0) - (b.pid || 0)
    if (va == null) return 1 // 空值始终排最后
    if (vb == null) return -1
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb), 'zh-Hans-CN') * dir
    }
    return (Number(va) - Number(vb)) * dir
  })
})

watch(range, load)
watch(() => props.host?.id, () => {
  dirFilter.value = ''
  compareSet.clear()
  seededDirs.clear() // 换主机：目录集不同，重新默认全选
  loading.value = true
  load()
})
watch(dirMetric, () => renderDirs())

let timer = null
onMounted(() => {
  load()
  timer = setInterval(() => { if (!document.hidden) load() }, 15_000)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('resize', onResize)
  if (charts) { charts.instances.forEach((c) => c.dispose()); charts.instances.clear() }
})
</script>

<template>
  <section class="detail-panel">
    <div class="detail-head">
      <span class="detail-bar" :class="host.group && /公网|public/i.test(host.group) ? 'public' : ''" />
      <div class="detail-title">
        <b>{{ host.name }}</b>
        <span class="sub">{{ host.snap && host.snap.online
          ? `${host.snap.os} · CPU ${fmtPct(host.snap.cpu?.pct)}% · 内存 ${fmtPct(host.snap.mem?.pct)}% · 运行 ${fmtUptime(host.snap.uptimeSec)}`
          : (host.error || '等待探测') }}</span>
      </div>
      <div class="range-tabs">
        <button v-for="r in RANGES" :key="r.v" :class="{ on: range === r.v }" @click="range = r.v">{{ r.label }}</button>
      </div>
      <button class="head-btn gear" title="设置该主机（连接 / 跟踪目录）" @click="emit('edit')">⚙</button>
      <button class="head-btn accent" @click="emit('term')">终端</button>
      <button class="head-btn" @click="emit('close')">收起</button>
    </div>

    <p v-if="err" class="detail-err">加载失败：{{ err }}</p>

    <div class="group-cap">资源趋势 <span>曲线颜色见各图图例 · 纵轴按所选时段的峰值自适应</span></div>
    <div class="charts4">
      <div class="chart-box">
        <h4>CPU 使用率 <span v-if="cpuNow != null" class="hint">当前 {{ cpuNow.toFixed(1) }}% · 峰值 {{ cpuPeak.toFixed(1) }}%</span></h4>
        <div ref="elCpu" class="chart" />
      </div>
      <div class="chart-box"><h4>内存使用率</h4><div ref="elMem" class="chart" /></div>
      <div class="chart-box"><h4>网络（{{ host.snap?.net?.iface || '-' }}）</h4><div ref="elNet" class="chart" /></div>
      <div class="chart-box"><h4>磁盘 IO</h4><div ref="elDio" class="chart" /></div>
    </div>

    <div class="group-cap">目录维度 <span>按主页登记 / 监控设置的跟踪目录聚合</span></div>
    <div class="chart-box" style="margin-bottom:12px">
      <h4 class="with-ctl">应用 / 目录资源占比
        <select v-model="dirMetric" class="mini-select">
          <option v-for="m in METRICS" :key="m.v" :value="m.v">{{ m.label }}</option>
        </select>
        <span class="hint">点击条目过滤下方进程</span>
      </h4>
      <div v-if="dirsList.length" ref="elDirs" class="chart wide-tall" />
      <p v-else class="dirs-empty">该主机暂无命中跟踪目录的进程 —— 可在「⚙ 监控设置 → 对应主机」中添加该机上的应用目录（如 /opt/myapp），目录级资源统计即按主机生效。</p>
    </div>

    <div v-if="dirsList.length" class="chart-box">
      <h4 class="with-ctl">目录历史对比（CPU%）<span class="hint">勾选目录叠加曲线</span>
        <button class="mini-link" @click="setAllCompare(true)">全选</button>
        <button class="mini-link" @click="setAllCompare(false)">清空</button>
      </h4>
      <div class="compare-list">
        <label v-for="d in dirsList" :key="d.path" class="dir-chip" :class="{ on: compareSet.has(d.path) }">
          <input type="checkbox" :checked="compareSet.has(d.path)" @change="toggleCompare(d.path)" />{{ d.name }}
        </label>
        <span v-if="!dirsList.length" class="hint">该主机暂无目录命中</span>
      </div>
      <div v-show="compareSet.size" ref="elCmp" class="chart" />
      <p v-if="!compareSet.size" class="compare-empty">未选择目录 —— 勾选上方目录名，即可把多个应用的 CPU% 曲线叠在同一时间轴上对比。</p>
    </div>

    <div class="group-cap">进程明细 <span>仅归属到跟踪目录的进程</span></div>
    <div class="chart-box">
      <h4 class="with-ctl">
        <span class="hint">归属进程 {{ procsList.length }} / 主机总进程 {{ procsTotal }}
          <template v-if="dirFilter"> · 已过滤「{{ dirsList.find((d) => d.path === dirFilter)?.name || dirFilter }}」</template>
        </span>
        <button v-if="dirFilter" class="mini-btn" @click="dirFilter = ''">清除过滤</button>
      </h4>
      <div class="table-scroll">
        <table class="proc-table">
          <thead>
            <tr>
              <th
                v-for="c in PROC_COLS"
                :key="c.key"
                :class="[{ num: c.num }, 'sortable', { on: sortKey === c.key }]"
                :aria-sort="sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'"
                @click="sortBy(c.key)"
              >{{ c.label }}<span class="sort-arrow">{{ sortKey === c.key ? (sortDir === 1 ? '↑' : '↓') : '' }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in sortedProcs" :key="p.pid">
              <td class="num" :title="p.cmd">{{ p.name }}</td>
              <td><span class="dir-tag" :class="{ container: p.dir && p.dir.startsWith('docker:') }">{{ p.dirName || '-' }}</span></td>
              <td class="num">{{ p.pid }}</td>
              <td class="num">{{ p.cpuPct == null ? '-' : p.cpuPct.toFixed(2) }}</td>
              <td class="num">{{ fmtMb(p.memMb) }}</td>
              <td class="num">{{ fmtMbs(p.ioReadMbs) }}</td>
              <td class="num">{{ fmtMbs(p.ioWriteMbs) }}</td>
              <td class="num">{{ p.threads }}</td>
              <td class="num">{{ p.fds || '-' }}</td>
              <td>{{ p.container || '-' }}</td>
              <td class="proc-cmd" :title="p.cmd">{{ p.cmd }}</td>
            </tr>
            <tr v-if="!sortedProcs.length">
              <td colspan="11" class="empty">无归属进程</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.detail-panel {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 16px 18px;
  margin-top: 16px;
}
/* sticky 上下文头：负 margin 铺满卡片宽度，滚过图表/表格时主机名与时间范围常驻 */
.detail-head {
  position: sticky;
  top: 59px; /* 顶栏 60px 高 - 1px 边框 */
  z-index: 15;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin: -16px -18px 12px; padding: 12px 18px;
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border);
  border-radius: 12px 12px 0 0;
}
.group-cap { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--text-2); margin: 16px 0 8px; }
.group-cap:first-of-type { margin-top: 2px; }
.group-cap span { font-weight: 400; font-size: 11.5px; color: var(--text-3, var(--gray)); }
.group-cap::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.detail-bar { width: 4px; height: 22px; border-radius: 2px; background: var(--accent); flex: none; }
.detail-bar.public { background: var(--amber); }
.detail-title { display: flex; flex-direction: column; min-width: 200px; }
.detail-title b { font-size: 15px; }
.detail-title .sub { font-size: 12px; }
.detail-err { color: var(--red); font-size: 13px; margin: 4px 0 10px; }

.charts4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
.chart-box {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px 8px;
  min-width: 0;
}
.chart-box h4 { margin: 0 0 4px; font-size: 12.5px; font-weight: 500; color: var(--text-2); }
.chart-box h4.with-ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chart-box .hint { font-size: 11.5px; color: var(--gray); font-weight: 400; }
.chart { width: 100%; height: 190px; }
.chart.wide-tall { height: 260px; }

.dirs-empty { margin: 0; padding: 26px 8px; color: var(--text-3); font-size: 12.5px; text-align: center; background: var(--bg-hover); border-radius: 8px; }

/* 详情头按钮：软胶囊两档（强调 / 中性） */
.head-btn {
  padding: 5px 16px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
  color: var(--text-2); background: var(--bg-hover); border: 0;
  transition: color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.head-btn:hover { color: var(--text); background: var(--accent-soft); }
.head-btn.accent { color: var(--accent); background: var(--accent-soft); font-weight: 500; }
.head-btn.accent:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: 0 2px 10px rgb(37 99 235 / 0.18); }
.head-btn.gear { font-size: 15px; padding: 5px 11px; }

/* 分段式时间窗（与主站 segmented 同族） */
.range-tabs { display: inline-flex; padding: 3px; gap: 2px; border-radius: 9px; background: var(--bg-hover); }
.range-tabs button { border: 0; background: transparent; padding: 4px 14px; border-radius: 7px; font-size: 12.5px; cursor: pointer; color: var(--text-2); transition: color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
.range-tabs button.on { background: var(--bg-soft); color: var(--accent); font-weight: 500; box-shadow: 0 1px 4px rgb(16 24 40 / 0.12); }
/* 目录指标下拉：去原生灰底，统一为胶囊控件 + 自绘箭头 */
.mini-select {
  appearance: none;
  -webkit-appearance: none;
  height: 26px;
  padding: 0 28px 0 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background-color: var(--bg-soft);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238c959f' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.mini-select:hover { border-color: var(--border-strong); }
.mini-select:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }

.compare-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.mini-link { border: 0; background: none; color: var(--accent); font-size: 12px; cursor: pointer; padding: 0 2px; font-weight: 400; }
.mini-link:hover { text-decoration: underline; }
.compare-empty { margin: 0; padding: 14px 4px 10px; color: var(--gray); font-size: 12.5px; text-align: center; }
.dir-chip {
  font-size: 12px; border: 1px solid var(--border); border-radius: 999px;
  padding: 2px 10px; cursor: pointer; color: var(--text-2);
  display: inline-flex; align-items: center; gap: 5px;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.dir-chip input {
  appearance: none; -webkit-appearance: none;
  width: 13px; height: 13px; margin: 0; flex: none;
  border: 1px solid var(--border-strong); border-radius: 4px;
  background: var(--bg-soft); cursor: pointer; position: relative;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.dir-chip input:checked { background: var(--accent); border-color: var(--accent); }
.dir-chip input:checked::after {
  content: ''; position: absolute; left: 3.5px; top: 1px;
  width: 4px; height: 7px; border: solid #fff; border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.dir-chip:hover { border-color: var(--accent); color: var(--accent); }
.dir-chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

.table-scroll { max-height: 380px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.proc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.proc-table th, .proc-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.proc-table th { color: var(--text-2); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--bg-soft); z-index: 1; }
.proc-table th.sortable { cursor: pointer; user-select: none; transition: color 0.15s ease; }
.proc-table th.sortable:hover { color: var(--text); }
.proc-table th.sortable.on { color: var(--accent); }
.sort-arrow { display: inline-block; width: 11px; margin-left: 2px; font-size: 10px; text-align: center; opacity: 0.8; }
.proc-table td.num, .proc-table th.num { text-align: right; font-family: var(--mono); }
.proc-table tbody tr { transition: background 0.12s ease; }
.proc-table tbody tr:hover { background: var(--bg-hover); }
.proc-cmd { max-width: 340px; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); font-size: 11.5px; }
.dir-tag { font-size: 11px; border-radius: 999px; padding: 1px 8px; background: var(--accent-soft); color: var(--accent); }
.dir-tag.container { background: var(--teal-soft); color: var(--teal); }
.empty { color: var(--text-2); text-align: center; padding: 18px; }

@media (max-width: 1180px) { .charts4 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 640px) { .charts4 { grid-template-columns: 1fr; } }
</style>
