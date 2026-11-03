<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import AppTable from './components/AppTable.vue'
import AppCard from './components/AppCard.vue'
import SettingsPanel from './components/SettingsPanel.vue'

/* ---------- 页面信息（可在首页设置面板中修改） ---------- */
const page = ref({
  siteName: '我的应用导航',
  heroTitle: '我的应用',
  heroSubtitle: '部署在这台服务器上的个人项目，端口与运行状态由服务端每 5 分钟自动探测。',
})
watch(
  () => page.value.siteName,
  (v) => {
    document.title = v || '我的应用导航'
  },
)

/* ---------- 数据获取：apps.json 由探测器每 5 分钟生成，页面每 60 秒轮询 ---------- */
const apps = shallowRef([])
const probedAt = ref('')
const loading = ref(true)
const loadError = ref('')
const settingsOpen = ref(false)
const syncing = ref(false)
const syncError = ref('')
const POLL_MS = 60_000
let pollTimer = null

async function fetchApps(silent = false) {
  if (!silent) {
    loading.value = true
    loadError.value = ''
  }
  try {
    const res = await fetch(`./apps.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    apps.value = data.apps ?? []
    probedAt.value = data.probedAt ?? ''
    if (data.page) page.value = { ...page.value, ...data.page }
    loadError.value = ''
  } catch (err) {
    if (!silent) loadError.value = `加载应用数据失败：${err.message}`
  } finally {
    loading.value = false
  }
}

/* ---------- 主题 ---------- */
const theme = ref(localStorage.getItem('theme') ?? 'auto')
const isDark = ref(false)
const mql = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme() {
  isDark.value = theme.value === 'dark' || (theme.value === 'auto' && mql.matches)
  document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light'
}

function toggleTheme() {
  theme.value = isDark.value ? 'light' : 'dark'
  localStorage.setItem('theme', theme.value)
  applyTheme()
}

/* ---------- 视图切换（移动端默认卡片，手动切换后尊重用户选择） ---------- */
const view = ref('table')
const viewPicked = ref(false)
const narrowMql = window.matchMedia('(max-width: 760px)')

function applyDefaultView() {
  if (!viewPicked.value) view.value = narrowMql.matches ? 'card' : 'table'
}

narrowMql.addEventListener('change', applyDefaultView)

function pickView(v) {
  view.value = v
  viewPicked.value = true
}

/* ---------- 排序（表格表头与工具栏下拉共用同一状态） ---------- */
const SORTS = {
  default: { label: '手动 / 默认顺序' },
  name: { label: '名称', dir: 1 },
  port: { label: '端口', dir: 1 },
  status: { label: '运行状态', dir: 1 },
  git: { label: '同步状态', dir: 1 },
}
const sortKey = ref('default')
const sortDir = ref(1)

/* ---------- 手动排序：拖拽 / 上下移动，保存在本浏览器（localStorage） ---------- */
const ORDER_STORAGE_KEY = 'my-homepage:appOrder'
const customOrder = ref([])
try {
  customOrder.value = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY)) ?? []
} catch {
  customOrder.value = []
}

function saveOrder(ids) {
  customOrder.value = ids
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

function resetOrder() {
  customOrder.value = []
  try {
    localStorage.removeItem(ORDER_STORAGE_KEY)
  } catch {
    /* 同上 */
  }
}

function moveApp(id, delta) {
  const ids = displayApps.value.map((a) => a.id)
  const i = ids.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  saveOrder(ids)
}

function onDropRow(fromId, targetId) {
  if (!fromId || fromId === targetId) return
  const ids = displayApps.value.map((a) => a.id)
  const fi = ids.indexOf(fromId)
  if (fi < 0 || ids.indexOf(targetId) < 0) return
  ids.splice(fi, 1)
  ids.splice(ids.indexOf(targetId), 0, fromId)
  saveOrder(ids)
}

// 数值越小越靠前；git 状态按"问题严重程度"排，未同步的在前
const RANK_RUNNING = { running: 0, down: 1 }
const statusRank = (a) => (a.appOnly ? 2 : (RANK_RUNNING[a.status] ?? 9))
const RANK_GIT = { dirty: 0, 'no-repo': 1, ahead: 2, behind: 3, untracked: 4, error: 5, 'no-upstream': 6, synced: 9 }
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')

function compareApps(a, b) {
  switch (sortKey.value) {
    case 'name':
      return byName(a, b)
    case 'port':
      return (a.port ?? Infinity) - (b.port ?? Infinity)
    case 'status':
      return statusRank(a) - statusRank(b) || byName(a, b)
    case 'git':
      return (RANK_GIT[a.git?.status] ?? 9) - (RANK_GIT[b.git?.status] ?? 9) || byName(a, b)
    default:
      return 0
  }
}

function setSort(key) {
  if (key !== 'default' && sortKey.value === key) {
    sortDir.value = -sortDir.value
  } else {
    sortKey.value = key
    sortDir.value = SORTS[key]?.dir ?? 1
  }
}

function onSortSelect() {
  sortDir.value = SORTS[sortKey.value]?.dir ?? 1
}

/* 保存设置后：立即刷新一次，并轮询 apps.json 直到后台探测完成（probedAt 变化）再刷新 */
let probeWatch = null

function onSaved(savedAt) {
  fetchApps(true)
  if (probeWatch) clearInterval(probeWatch)
  let tries = 0
  probeWatch = setInterval(async () => {
    tries++
    try {
      const r = await fetch(`./apps.json?t=${Date.now()}`, { cache: 'no-store' })
      const d = await r.json()
      if ((d.probedAt && new Date(d.probedAt).getTime() > savedAt) || tries > 40) {
        clearInterval(probeWatch)
        probeWatch = null
        fetchApps(true)
      }
    } catch {
      /* 下一轮再试 */
    }
  }, 1500)
}

/* ---------- 立刻同步：触发一次完整探测（含 git fetch），轮询到 probedAt 更新 ---------- */
function waitForProbe(after) {
  return new Promise((resolve) => {
    let tries = 0
    const timer = setInterval(async () => {
      tries++
      try {
        const r = await fetch(`./apps.json?t=${Date.now()}`, { cache: 'no-store' })
        const d = await r.json()
        if (d.probedAt && new Date(d.probedAt).getTime() > after) {
          clearInterval(timer)
          resolve(true)
          return
        }
      } catch {
        /* 下一轮再试 */
      }
      if (tries >= 90) {
        clearInterval(timer)
        resolve(false)
      }
    }, 2000)
  })
}

async function syncNow() {
  if (syncing.value) return
  syncing.value = true
  syncError.value = ''
  try {
    const res = await fetch('/api/probe', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    // 用服务端返回的 startedAt 比较，避免浏览器与服务器时钟偏差
    const startedAt = data.startedAt ?? Date.now()
    const done = await waitForProbe(startedAt)
    await fetchApps(true)
    if (!done) syncError.value = '同步超时，请稍后刷新查看'
  } catch (err) {
    syncError.value = `同步失败：${err.message}`
  } finally {
    syncing.value = false
  }
}

const displayApps = computed(() => {
  let list = [...apps.value]
  if (sortKey.value !== 'default') {
    list.sort((a, b) => compareApps(a, b) * sortDir.value)
  } else if (customOrder.value.length) {
    // 手动顺序优先于 apps.json 的原始顺序，新发现的应用排在最后
    const rank = new Map(customOrder.value.map((id, i) => [id, i]))
    list.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }
  return list
})

const runningCount = computed(() => apps.value.filter((a) => a.status === 'running').length)
const isPublic = (a) => (a.env ? a.env === 'public' : Boolean(a.remote))
const lanCount = computed(() => apps.value.filter((a) => !isPublic(a)).length)
const netCount = computed(() => apps.value.filter((a) => isPublic(a)).length)
const gitUnsynced = computed(
  () => apps.value.filter((a) => a.git && a.git.status !== 'synced').length,
)
const probedTimeText = computed(() => {
  if (!probedAt.value) return ''
  const d = new Date(probedAt.value)
  // 服务端按 UTC 输出 ISO；固定按北京时间显示，避免浏览器时区不同导致时间偏差
  return `最后探测 ${d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}（北京时间）`
})

const year = new Date().getFullYear()

onMounted(() => {
  applyTheme()
  applyDefaultView()
  mql.addEventListener('change', applyTheme)
  fetchApps()
  pollTimer = setInterval(() => fetchApps(true), POLL_MS)
  // 从后台切回页面时立即刷新一次
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchApps(true)
  })
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
  mql.removeEventListener('change', applyTheme)
})
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="./">
        <span class="brand-mark" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <rect x="0.5" y="0.5" width="6.5" height="6.5" rx="1.8" />
            <rect x="9" y="0.5" width="6.5" height="6.5" rx="1.8" />
            <rect x="0.5" y="9" width="6.5" height="6.5" rx="1.8" />
            <rect x="9" y="9" width="6.5" height="6.5" rx="1.8" opacity="0.55" />
          </svg>
        </span>
        {{ page.siteName }}
      </a>
      <div class="topbar-actions">
        <a
          class="icon-btn"
          href="https://github.com/guojiaxian"
          target="_blank"
          rel="noopener"
          title="GitHub 主页"
        >
          <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
            />
          </svg>
        </a>
        <button class="icon-btn" title="设置" @click="settingsOpen = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </button>
        <button class="icon-btn" :title="isDark ? '切换浅色' : '切换深色'" @click="toggleTheme">
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
          </svg>
        </button>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="hero">
      <h1>{{ page.heroTitle }}</h1>
      <p class="sub">{{ page.heroSubtitle }}</p>
      <div class="stats">
        <span class="stat-chip"><b>{{ apps.length }}</b> 个应用</span>
        <span class="stat-chip">
          <span class="dot" :style="{ background: runningCount ? 'var(--green)' : 'var(--gray)' }" />
          <b>{{ runningCount }}</b> 个运行中
        </span>
        <span class="stat-chip" title="按部署位置：内网 / 公网">
          内网 <b style="color: var(--accent)">{{ lanCount }}</b>
          <span style="color: var(--gray)">·</span>
          公网 <b style="color: var(--amber)">{{ netCount }}</b>
        </span>
        <span class="stat-chip" title="源码与 GitHub 仓库的同步状态">
          <span class="dot" :style="{ background: gitUnsynced ? 'var(--amber)' : 'var(--green)' }" />
          <template v-if="gitUnsynced"><b>{{ gitUnsynced }}</b> 个源码未同步</template>
          <template v-else>源码全部已同步</template>
        </span>
      </div>
    </section>

    <div class="toolbar">
      <div class="sort-box">
        <select v-model="sortKey" title="排序方式" @change="onSortSelect">
          <option v-for="(s, k) in SORTS" :key="k" :value="k">排序：{{ s.label }}</option>
        </select>
        <button
          v-if="sortKey !== 'default'"
          class="icon-btn"
          :title="sortDir === 1 ? '正序（点击切换倒序）' : '倒序（点击切换正序）'"
          @click="sortDir = -sortDir"
        >
          {{ sortDir === 1 ? '↑' : '↓' }}
        </button>
        <button
          v-if="sortKey === 'default' && customOrder.length"
          class="icon-btn"
          title="清除手动排序，恢复默认顺序"
          @click="resetOrder"
        >
          ↺
        </button>
      </div>
      <div class="segmented" role="tablist">
        <button :class="{ active: view === 'table' }" @click="pickView('table')">表格</button>
        <button :class="{ active: view === 'card' }" @click="pickView('card')">卡片</button>
      </div>
      <button
        class="sync-btn"
        :class="{ syncing }"
        :disabled="syncing"
        :title="syncError || '立即重新探测所有应用：端口、git 同步与远程健康'"
        @click="syncNow"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
        {{ syncing ? '同步中…' : '立刻同步' }}
      </button>
      <span v-if="syncError" class="sync-error">{{ syncError }}</span>
    </div>

    <div v-if="loading" class="placeholder" aria-busy="true">
      <div class="skeleton-row" style="max-width: 720px; margin-left: auto; margin-right: auto" />
      <div class="skeleton-row" style="max-width: 720px; margin-left: auto; margin-right: auto" />
      <div class="skeleton-row" style="max-width: 720px; margin-left: auto; margin-right: auto" />
    </div>

    <div v-else-if="loadError" class="placeholder">
      <p>{{ loadError }}</p>
      <button class="icon-btn" style="width: auto; padding: 0 16px" @click="fetchApps()">重试</button>
    </div>

    <p v-else-if="displayApps.length === 0" class="placeholder">还没有应用，请检查 apps.json</p>

    <AppTable
      v-else-if="view === 'table'"
      :apps="displayApps"
      :sort-key="sortKey"
      :sort-dir="sortDir"
      :reorderable="sortKey === 'default'"
      @sort="setSort"
      @move="moveApp"
      @drop-reorder="onDropRow"
    />
    <AppCard
      v-else
      :apps="displayApps"
      :reorderable="sortKey === 'default'"
      @move="moveApp"
      @move-all="saveOrder"
    />

    <footer class="footer">
      <span>© {{ year }} {{ page.siteName }} · Powered by Vue</span>
      <span v-if="probedTimeText">{{ probedTimeText }} · 端口每 3 分钟 · git 每 5 分钟</span>
    </footer>
  </main>

  <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" @saved="onSaved" />
</template>
