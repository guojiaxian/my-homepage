<script setup>
import { nextTick, onBeforeUnmount, onMounted, computed, reactive, ref } from 'vue'
import { monApi } from '../lib/monitor-api.js'

/* 批量终端：最多 6 台并排，命令栏一条输入广播到全部窗格；
   点击某窗格进入单机交互（密码提示/交互式程序），点命令栏回到广播。
   布局规则（用户指定）：≤3 台一行并排；≥4 台两行并排（每行 3 格）。 */
const props = defineProps({ hosts: { type: Array, default: () => [] } }) // [{ id, name }]
const emit = defineEmits(['close'])

const full = ref(false)
const barText = ref('')
const lastSent = ref('')
const solo = ref(null) // 当前单机交互的窗格
const barInput = ref(null)
const panes = reactive(props.hosts.map((h) => ({
  id: h.id, name: h.name || h.id,
  status: '连接中…', statusCls: '',
  term: null, ws: null, fit: null, el: null,
})))

const gridStyle = computed(() => {
  const n = panes.length
  const cols = n >= 4 ? 3 : Math.max(1, n)
  return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
})
const rowsCls = computed(() => (panes.length >= 4 ? 'rows-2' : 'rows-1'))

let XTerm = null, XFit = null
async function ensureLibs() {
  if (XTerm) return
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
  await import('@xterm/xterm/css/xterm.css')
  XTerm = Terminal; XFit = FitAddon
}
async function openAll() {
  await ensureLibs()
  await nextTick()
  for (const pane of panes) connect(pane)
}

function setStatus(pane, txt, cls = '') { pane.status = txt; pane.statusCls = cls }

function connect(pane) {
  if (pane.ws) { try { pane.ws.close() } catch { /* 已关 */ } pane.ws = null }
  if (pane.term) { try { pane.term.dispose() } catch { /* 已释放 */ } pane.term = null }
  pane.el.innerHTML = ''
  setStatus(pane, '连接中…')
  const term = new XTerm({
    fontFamily: "'Cascadia Code', Menlo, Consolas, monospace",
    fontSize: Math.max(11, Math.floor(13.5 - (panes.length >= 4 ? 2 : 0))),
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#4d9fff', selectionBackground: '#264f78' },
    cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    scrollback: 3000,
  })
  const fit = new XFit()
  term.loadAddon(fit)
  term.open(pane.el)
  fit.fit()
  pane.term = term; pane.fit = fit
  /* 普通缓冲区下 PageUp/PageDown 翻终端历史，不再发给 shell；
     备用屏（vim / less 等）仍交给应用处理 */
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || ev.altKey || ev.ctrlKey || ev.metaKey) return true
    if (ev.key !== 'PageUp' && ev.key !== 'PageDown') return true
    if (term.buffer.active.type !== 'normal') return true
    term.scrollPages(ev.key === 'PageUp' ? -1 : 1)
    return false
  })
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/terminal?host=${encodeURIComponent(pane.id)}&cols=${term.cols}&rows=${term.rows}`)
  pane.ws = ws
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => setStatus(pane, `已连接`, 'ok')
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return }
    try {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'error') setStatus(pane, '错误：' + msg.message, 'bad')
    } catch { /* 非控制帧 */ }
  }
  ws.onclose = (ev) => {
    if (pane.ws !== ws) return
    setStatus(pane, ev.reason ? `断开（${ev.reason}）` : '断开', 'bad')
    if (solo.value === pane) { solo.value = null } // 断连窗格自动回广播
  }
  ws.onerror = () => setStatus(pane, '连接失败', 'bad')
  term.onData((d) => { if (ws.readyState === 1) ws.send(d) }) // 单机交互：点击窗格聚焦后直接键入
  term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })) })
}

function reconnect(pane) { connect(pane) }

/* 命令栏：广播到全部就绪窗格 */
function sendBar() {
  const text = barText.value
  if (!text.trim()) return
  // 单机模式下命令栏只发给 solo 窗格；广播模式发全部
  const targets = solo.value ? [solo.value] : panes
  let n = 0
  for (const pane of targets) {
    if (pane.ws && pane.ws.readyState === 1) { pane.ws.send(text + '\r'); n++ }
  }
  barText.value = ''
  lastSent.value = solo.value ? `已下发到 ${n} 台（单机：${solo.value.name}）` : `已下发到 ${n} 台`
}

function focusPane(pane) {
  solo.value = pane
  pane.term && pane.term.focus()
}
/* 命令栏 PageUp/PageDown：广播模式翻全部窗格，单机模式只翻当前窗格 */
function scrollPanes(dir) {
  const targets = solo.value ? [solo.value] : panes
  for (const pane of targets) { try { pane.term && pane.term.scrollPages(dir) } catch { /* 未就绪 */ } }
}
function onBarKeydown(e) {
  if (e.key !== 'PageUp' && e.key !== 'PageDown') return
  e.preventDefault()
  scrollPanes(e.key === 'PageUp' ? -1 : 1)
}
function backToBroadcast() {
  solo.value = null
  barInput.value && barInput.value.focus()
}

/* 全屏 */
async function toggleFull() {
  full.value = !full.value
  await nextTick()
  refitAll()
  setTimeout(refitAll, 80)
}
function refitAll() {
  for (const pane of panes) {
    try { pane.fit && pane.fit.fit() } catch { /* 忽略 */ }
  }
}
function onKeydown(e) {
  if (e.key !== 'Escape') return
  if (full.value) { e.preventDefault(); e.stopPropagation(); toggleFull() }
}
window.addEventListener('keydown', onKeydown, true)
window.addEventListener('resize', refitAll)
/* 滚轮滚动链守卫：批量层是全屏覆盖层，wheel 不应再滚动背后的页面；
   xterm 回滚在其内部监听（冒泡更早）中已完成，不受影响 */
const maskEl = ref(null), boxEl = ref(null)
function guardWheel(e) { e.preventDefault() }
onMounted(() => {
  maskEl.value?.addEventListener('wheel', guardWheel, { passive: false })
  boxEl.value?.addEventListener('wheel', guardWheel, { passive: false })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', refitAll)
  maskEl.value?.removeEventListener('wheel', guardWheel)
  boxEl.value?.removeEventListener('wheel', guardWheel)
  for (const pane of panes) {
    try { pane.ws && pane.ws.close() } catch { /* 已关 */ }
    try { pane.term && pane.term.dispose() } catch { /* 已释放 */ }
  }
})

onMounted(openAll)
</script>

<template>
  <Teleport to="body">
    <div ref="maskEl" class="mbt-mask" @click.self="emit('close')" />
    <div ref="boxEl" class="mbt" :class="[rowsCls, { full }]">
      <div class="mbt-head">
        <span class="mbt-title">批量终端 · {{ panes.length }} 台</span>
        <span class="mbt-mode" :class="{ solo: !!solo }">
          {{ solo ? `单机输入：${solo.name}` : `广播：输入将下发到全部 ${panes.length} 台` }}
        </span>
        <span class="mbt-hint" title="滚轮或 PageUp / PageDown 翻页；点击窗格可单机输入">滚轮 / PageUp 翻页</span>
        <span class="grow" />
        <button class="mbt-btn" :class="{ accent: !solo }" @click="backToBroadcast" :disabled="!solo">广播模式</button>
        <button class="mbt-btn" @click="toggleFull">{{ full ? '还原窗口' : '全屏' }}</button>
        <button class="mbt-btn" @click="emit('close')">✕ 关闭</button>
      </div>

      <div class="panes" :style="gridStyle">
        <div
          v-for="pane in panes"
          :key="pane.id"
          class="pane"
          :class="{ solo: solo === pane }"
          @click="focusPane(pane)"
        >
          <div class="pane-head">
            <span class="pane-dot" :style="{ background: pane.statusCls === 'ok' ? 'var(--green)' : pane.statusCls === 'bad' ? 'var(--red)' : 'var(--text-2)' }" />
            <span class="pane-name" :title="pane.id">{{ pane.name }}</span>
            <span class="pane-status" :class="pane.statusCls">{{ pane.status }}</span>
            <span class="grow" />
            <button class="mbt-btn sm" :disabled="pane.statusCls === 'bad' && !pane.term" @click.stop="reconnect(pane)">重连</button>
            <span v-if="solo === pane" class="pane-solo-tag">单机输入</span>
          </div>
          <div class="pane-term" :ref="(el) => (pane.el = el)" />
        </div>
      </div>

      <div class="mbt-bar">
        <span class="mbt-prompt" :class="{ solo: !!solo }">{{ solo ? '单机 ▸' : '广播 ▸' }}</span>
        <input
          ref="barInput"
          v-model="barText"
          type="text"
          :placeholder="solo ? `输入仅在 ${solo.name} 执行（密码/交互式提示请在此操作或点击窗格）` : '输入命令，回车同时下发到全部主机…'"
          autocomplete="off"
          spellcheck="false"
          @keydown="onBarKeydown"
          @keydown.enter="sendBar"
        />
        <button class="mbt-btn accent" @click="sendBar">下发</button>
        <span v-if="lastSent" class="mbt-sent">{{ lastSent }}</span>
        <button v-if="solo" class="mbt-btn" @click="backToBroadcast">返回广播</button>
      </div>
    </div>
  </Teleport>
</template>

<script>
export default { name: 'MonitorBatchTerm' }
</script>

<style scoped>
.grow { flex: 1; }
.mbt-mask { position: fixed; inset: 0; background: rgb(16 24 40 / 0.5); z-index: 85; }
.mbt {
  position: fixed; z-index: 86; inset: 24px 12px;
  width: calc(100vw - 24px); height: calc(100vh - 48px);
  background: var(--bg-soft); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: var(--shadow-hover);
  display: flex; flex-direction: column; overflow: hidden;
}
.mbt.full { inset: 0; width: 100vw; height: 100vh; border-radius: 0; border: 0; }
.mbt-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.mbt-title { font-weight: 600; }
.mbt-mode { font-size: 12.5px; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 1px 10px; }
.mbt-mode.solo { color: var(--amber); background: var(--amber-soft); }
.mbt-hint { font-size: 11.5px; color: var(--text-2); }
.mbt-btn {
  border: 0; background: var(--bg-hover); color: var(--text-2);
  border-radius: 999px; padding: 4px 14px; font-size: 12.5px; cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.mbt-btn:hover:not(:disabled) { color: var(--text); background: var(--accent-soft); }
.mbt-btn:disabled { opacity: 0.5; cursor: default; }
.mbt-btn.accent { color: var(--accent); background: var(--accent-soft); font-weight: 500; }

.panes { flex: 1; display: grid; gap: 8px; padding: 8px; min-height: 0; background: var(--bg); }
.panes.rows-1 { grid-auto-rows: minmax(0, 1fr); }
.panes.rows-2 { grid-auto-rows: minmax(0, 1fr); }
.pane {
  display: flex; flex-direction: column; min-width: 0; min-height: 0;
  border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
  background: #0d1117; cursor: text;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.pane.solo { border-color: var(--amber); box-shadow: 0 0 0 1px var(--amber), 0 0 18px color-mix(in srgb, var(--amber) 25%, transparent); }
.pane-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: #161b22; border-bottom: 1px solid #30363d; flex: none; }
.pane-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.pane-name { font-size: 12px; font-weight: 600; color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-status { font-size: 11px; color: #8b949e; }
.pane-status.ok { color: #3fb950; }
.pane-status.bad { color: #f85149; }
.pane-solo-tag { font-size: 10.5px; border-radius: 999px; padding: 0 8px; background: color-mix(in srgb, var(--amber) 20%, transparent); color: var(--amber); flex: none; }
.pane-term { flex: 1; padding: 4px 6px; min-height: 0; }
.pane-term :deep(.xterm) { height: 100%; }
/* xterm 默认滚动条是 overlay（宽度 0）不可拖拽，这里给批量窗格一个可见的细滚动条 */
.pane-term :deep(.xterm-viewport) {
  background-color: #0d1117 !important;
  scrollbar-width: thin;
  scrollbar-color: #3b4654 transparent;
  scrollbar-gutter: stable;
  overscroll-behavior: contain; /* 滚到回滚边界后不再外溢滚动底层页面 */
}
.pane-term :deep(.xterm-viewport::-webkit-scrollbar) { width: 9px; }
.pane-term :deep(.xterm-viewport::-webkit-scrollbar-track) { background: transparent; }
.pane-term :deep(.xterm-viewport::-webkit-scrollbar-thumb) {
  background: #39424e; border-radius: 6px; border: 2px solid #0d1117;
}
.pane-term :deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) { background: #55606e; }
.mbt-btn.sm { padding: 1px 8px; font-size: 11.5px; }

.mbt-bar { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-top: 1px solid var(--border); background: var(--bg-soft); }
.mbt-prompt { font-family: var(--mono); font-size: 12.5px; font-weight: 600; color: var(--accent); flex: none; }
.mbt-prompt.solo { color: var(--amber); }
.mbt-bar input {
  flex: 1; font: inherit; font-family: var(--mono); font-size: 13px;
  color: var(--text); background: var(--bg); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 7px 12px; outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.mbt-bar input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.mbt-bar .mbt-btn.accent { padding: 7px 18px; }

@media (max-width: 900px) {
  .mbt { inset: 8px 6px; width: calc(100vw - 12px); height: calc(100vh - 16px); }
  .panes { grid-template-columns: 1fr !important; grid-auto-rows: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .pane, .mbt-btn { transition: none !important; }
}
</style>
