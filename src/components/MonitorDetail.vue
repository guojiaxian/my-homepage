<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { monApi, fmtMb, fmtMbs, fmtPct, fmtUptime } from '../lib/monitor-api.js'

const props = defineProps({
  host: { type: Object, required: true }, // summary 里的主机条目（随父级轮询更新）
  thresholds: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['term', 'close'])

const range = ref('1h')
const hist = ref([])
const dirsList = ref([])
const procsList = ref([])
const procsTotal = ref(0)
const dirMetric = ref('mem')
const dirFilter = ref('')
const compareSet = reactive(new Set())
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

function renderTrends() {
  const { baseOption, lineSeries, legendStyle, cssVar } = mod()
  const t = (p) => p.t
  const c = inst('cpu', elCpu.value)
  const th = props.thresholds?.cpuPct ?? 85
  c.setOption({
    ...baseOption('{value}%', range.value),
    legend: { ...legendStyle(), show: false },
    yAxis: { ...baseOption('{value}%', range.value).yAxis, max: 100 },
    series: [
      lineSeries('CPU %', pts().map((p) => [t(p), p.cpu]), cssVar('--accent'), {
        markLine: pts().length ? {
          silent: true, symbol: 'none',
          lineStyle: { color: cssVar('--red'), type: 'dashed' },
          label: { color: cssVar('--red'), fontSize: 10, formatter: `${th}`, position: 'insideEndTop' },
          data: [{ yAxis: th }],
        } : undefined,
      }),
      lineSeries('负载', pts().map((p) => [t(p), p.load]), cssVar('--amber'), { noArea: true }),
    ],
  }, { notMerge: true })

  inst('mem', elMem.value).setOption({
    ...baseOption('{value}%', range.value),
    legend: { ...legendStyle(), show: false },
    yAxis: { ...baseOption('{value}%', range.value).yAxis, max: 100 },
    series: [
      lineSeries('内存 %', pts().map((p) => [t(p), p.mem]), cssVar('--purple')),
      lineSeries('Swap %', pts().map((p) => [t(p), p.swap]), cssVar('--teal'), { noArea: true }),
    ],
  }, { notMerge: true })

  inst('net', elNet.value).setOption({
    ...baseOption('{value}', range.value),
    legend: { ...legendStyle(), show: false },
    series: [
      lineSeries('下行 Mbps', pts().map((p) => [t(p), p.netI]), cssVar('--accent')),
      lineSeries('上行 Mbps', pts().map((p) => [t(p), p.netO]), cssVar('--green')),
    ],
  }, { notMerge: true })

  inst('dio', elDio.value).setOption({
    ...baseOption('{value}', range.value),
    legend: { ...legendStyle(), show: false },
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
    top.map((d) => d.name + (d.source === 'container' ? ' ⬛' : '')),
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

const filteredProcs = () =>
  procsList.value
    .filter((p) => !dirFilter.value || p.dir === dirFilter.value)
    .sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0))

watch(range, load)
watch(() => props.host?.id, () => {
  dirFilter.value = ''
  compareSet.clear()
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
      <button class="head-btn accent" @click="emit('term')">终端</button>
      <button class="head-btn" @click="emit('close')">收起</button>
    </div>

    <p v-if="err" class="detail-err">加载失败：{{ err }}</p>

    <div class="charts4">
      <div class="chart-box"><h4>CPU / 负载</h4><div ref="elCpu" class="chart" /></div>
      <div class="chart-box"><h4>内存 / Swap</h4><div ref="elMem" class="chart" /></div>
      <div class="chart-box"><h4>网络（{{ host.snap?.net?.iface || '-' }}）</h4><div ref="elNet" class="chart" /></div>
      <div class="chart-box"><h4>磁盘 IO</h4><div ref="elDio" class="chart" /></div>
    </div>

    <div class="chart-box" style="margin-bottom:12px">
      <h4 class="with-ctl">应用 / 目录资源占比
        <select v-model="dirMetric" class="mini-select">
          <option v-for="m in METRICS" :key="m.v" :value="m.v">{{ m.label }}</option>
        </select>
        <span class="hint">点击条目过滤下方进程</span>
      </h4>
      <div v-if="dirsList.length" ref="elDirs" class="chart wide-tall" />
      <p v-else class="dirs-empty">该主机没有命中跟踪目录（远程主机默认不跟踪目录）——目录级资源统计仅对已登记目录的主机展示。</p>
    </div>

    <div v-if="dirsList.length" class="chart-box">
      <h4 class="with-ctl">目录历史对比（CPU%）<span class="hint">勾选目录叠加曲线</span></h4>
      <div class="compare-list">
        <label v-for="d in dirsList" :key="d.path" class="dir-chip" :class="{ on: compareSet.has(d.path) }">
          <input type="checkbox" :checked="compareSet.has(d.path)" @change="toggleCompare(d.path)" />{{ d.name }}
        </label>
        <span v-if="!dirsList.length" class="hint">该主机暂无目录命中</span>
      </div>
      <div v-show="compareSet.size" ref="elCmp" class="chart" />
      <p v-if="!compareSet.size" class="compare-empty">未选择目录 —— 勾选上方目录名，即可把多个应用的 CPU% 曲线叠在同一时间轴上对比。</p>
    </div>

    <div class="chart-box">
      <h4 class="with-ctl">进程明细
        <span class="hint">归属进程 {{ procsList.length }} / 主机总进程 {{ procsTotal }}
          <template v-if="dirFilter"> · 已过滤「{{ dirsList.find((d) => d.path === dirFilter)?.name || dirFilter }}」</template>
        </span>
        <button v-if="dirFilter" class="mini-btn" @click="dirFilter = ''">清除过滤</button>
      </h4>
      <div class="table-scroll">
        <table class="proc-table">
          <thead>
            <tr>
              <th>程序</th><th>归属</th><th class="num">PID</th><th class="num">CPU%</th><th class="num">内存</th>
              <th class="num">IO读 MB/s</th><th class="num">IO写 MB/s</th><th class="num">线程</th><th class="num">句柄</th>
              <th>容器</th><th>命令行</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in filteredProcs()" :key="p.pid">
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
            <tr v-if="!filteredProcs().length">
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
.detail-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
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

/* 分段式时间窗（与主站 segmented 同族） */
.range-tabs { display: inline-flex; padding: 3px; gap: 2px; border-radius: 9px; background: var(--bg-hover); }
.range-tabs button { border: 0; background: transparent; padding: 4px 14px; border-radius: 7px; font-size: 12.5px; cursor: pointer; color: var(--text-2); transition: color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
.range-tabs button.on { background: var(--bg-soft); color: var(--accent); font-weight: 500; box-shadow: 0 1px 4px rgb(16 24 40 / 0.12); }
.mini-select { font-size: 12px; padding: 2px 8px; border-radius: 6px; }

.compare-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.compare-empty { margin: 0; padding: 14px 4px 10px; color: var(--gray); font-size: 12.5px; text-align: center; }
.dir-chip {
  font-size: 12px; border: 1px solid var(--border); border-radius: 999px;
  padding: 2px 10px; cursor: pointer; color: var(--text-2);
  display: inline-flex; align-items: center; gap: 5px;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.dir-chip input { accent-color: var(--accent); margin: 0; }
.dir-chip:hover { border-color: var(--accent); color: var(--accent); }
.dir-chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

.table-scroll { max-height: 380px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.proc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.proc-table th, .proc-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.proc-table th { color: var(--text-2); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--bg-soft); z-index: 1; }
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
