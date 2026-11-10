<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/* 终端窗格：多窗格布局里的一个会话。职责 = 连接（含并发受限自动重试）+
   广播上行（多端输入开启时把键入上抛给父级分发）+ 尺寸自适应。
   抽屉外壳 / 窗格排布 / 全屏 / ESC 均由 MonitorView 统一管理。 */
const props = defineProps({
  sessionKey: { type: String, default: '' },
  hostId: { type: String, default: '' },
  hostName: { type: String, default: '' },
  ordinal: { type: Number, default: 1 },
  /* 抽屉是否处于打开状态（关闭仅隐藏，窗格与 shell 现场保留） */
  visible: { type: Boolean, default: false },
  /* 多端输入：键入内容上抛父级广播到其他窗格 */
  broadcast: { type: Boolean, default: false },
})
const emit = defineEmits(['end', 'status', 'input', 'popout'])

const status = ref('')
const statusCls = ref('')
const containerRef = ref(null)
const rootEl = ref(null)
let term = null, ws = null, fit = null, loaded = false
let retryTimer = null, retryCount = 0, curHost = ''
let connectGen = 0 // 重入保护：每次 connect 递增，异步返回后校验

function setStatus(txt, cls = '') {
  status.value = txt
  statusCls.value = cls
  emit('status', props.sessionKey, cls)
}

function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null } }

async function connect() {
  if (!props.hostId) return
  const gen = ++connectGen
  curHost = props.hostId
  clearRetry()
  if (ws) { try { ws.close() } catch { /* 已关 */ } ws = null }
  if (term) { try { term.dispose() } catch { /* 已释放 */ } term = null }
  if (!loaded) {
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
    await import('@xterm/xterm/css/xterm.css')
    window.__monTermLib = { Terminal, FitAddon }
    loaded = true
  }
  const { Terminal, FitAddon } = window.__monTermLib
  const container = containerRef.value
  if (!container || gen !== connectGen) return // 已被更新的 connect 取代
  container.innerHTML = ''
  setStatus('连接中…')
  const t = new Terminal({
    fontFamily: "'Cascadia Code', Menlo, Consolas, monospace",
    fontSize: 13,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#4d9fff', selectionBackground: '#264f78' },
    cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    scrollback: 3000,
  })
  const f = new FitAddon()
  t.loadAddon(f)
  t.open(container)
  f.fit()
  term = t; fit = f
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  if (gen !== connectGen) return // 等待 libs 期间已被更新的 connect 取代
  const socket = new WebSocket(`${proto}://${location.host}/api/terminal?host=${encodeURIComponent(props.hostId)}&cols=${t.cols}&rows=${t.rows}`)
  if (gen !== connectGen) { try { socket.close() } catch {} return }
  ws = socket
  socket.binaryType = 'arraybuffer'
  socket.onopen = () => { setStatus('已连接', 'ok'); retryCount = 0; socket.idleTs = Date.now() }
  socket.onmessage = (ev) => {
    ws.idleTs = Date.now() // 服务端输出也算活跃（tail -f / top 不应被判空闲）
    if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return }
    try {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'error') setStatus('错误：' + msg.message, 'bad')
    } catch { /* 非控制帧 */ }
  }
  socket.onclose = (ev) => {
    if (ws !== socket) return
    /* 并发受限：自动延时重试（不放弃窗格，历史输出保留） */
    if (ev.code === 4029 || /并发/.test(ev.reason || '')) {
      retryCount += 1
      if (retryCount <= 30) {
        setStatus(`并发受限，20 秒后自动重连（第 ${retryCount} 次）`, 'bad')
        retryTimer = setTimeout(connect, 20_000)
      } else {
        setStatus('自动重连已达上限，请手动点击「重连」', 'bad')
      }
      return
    }
    setStatus(ev.reason ? `断开（${ev.reason}）` : '断开', 'bad')
  }
  socket.onerror = () => setStatus('连接失败', 'bad')
  /* 键入：本地必发；多端输入开启时上抛父级广播到其他窗格 */
  t.onData((d) => {
    if (socket.readyState === 1) socket.send(d)
    if (props.broadcast) emit('input', { from: props.sessionKey, text: d })
  })
  t.onResize(({ cols, rows }) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
  })
}

function reconnect() { connect() }
function popout() {
  /* 弹出窗口需要独立会话：释放本窗格，父级负责 window.open */
  emit('popout', props.sessionKey, props.hostId)
}
function endSession() { emit('end', props.sessionKey) }

/* 供父级调用的能力：广播下发 / 聚焦 / 重排 */
function send(d) { if (ws && ws.readyState === 1) ws.send(d) }
function paneFocus() { term && term.focus() }
function paneRefit() { try { fit && fit.fit() } catch { /* 忽略 */ } }
defineExpose({ send, focus: paneFocus, refit: paneRefit, el: rootEl })

/* 抽屉重新打开：只重排 + 聚焦，不重连（shell 现场保留） */
async function refitFocus() {
  await nextTick()
  requestAnimationFrame(paneRefit)
  setTimeout(() => { paneRefit(); paneFocus() }, 80)
}
watch(() => props.visible, (v) => { if (v) refitFocus() })
watch(() => props.hostId, (v) => { if (v && props.visible && curHost !== v) connect() })
onMounted(() => { connect() })

function onResizeWin() { if (props.visible) paneRefit() }
window.addEventListener('resize', onResizeWin)
onBeforeUnmount(() => {
  clearRetry()
  window.removeEventListener('resize', onResizeWin)
  if (ws) { try { ws.close() } catch { /* 已关 */ } ws = null }
  if (ws) { try { ws.close() } catch { /* 已关 */ } ws = null }
  if (term) { try { term.dispose() } catch { /* 已释放 */ } term = null }
  fit = null
})
</script>

<template>
  <div ref="rootEl" class="mtp" @click="paneFocus">
    <div class="mtp-head">
      <span class="pane-dot" :class="statusCls" />
      <span class="mtp-name" :title="hostName">
        {{ hostName }}<template v-if="ordinal > 1"> #{{ ordinal }}</template>
      </span>
      <span class="mtp-status" :class="statusCls" :title="status">{{ status }}</span>
      <span class="grow" />
      <button class="mini-btn sm" title="重新连接该会话" @click.stop="reconnect">重连</button>
      <button class="mini-btn sm" title="释放本窗格会话并在独立窗口打开" @click.stop="popout">弹出</button>
      <button class="mini-btn sm danger" title="结束该会话（shell 将关闭）" @click.stop="endSession">✕</button>
    </div>
    <div ref="containerRef" class="mtp-body" />
  </div>
</template>

<script>
export default { name: 'MonitorTermPane' }
</script>

<style scoped>
.grow { flex: 1; }
.mini-btn {
  border: 0; background: transparent; color: #8b949e;
  border-radius: 6px; padding: 1px 7px; font-size: 11.5px; cursor: pointer; flex: none;
  transition: color 0.15s ease, background 0.15s ease;
}
.mini-btn:hover { color: #e6edf3; background: #21262d; }
.mini-btn.danger:hover { color: #f85149; }
.mini-btn.sm { padding: 1px 6px; font-size: 11px; }
.mtp {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0; min-width: 0;
  background: #0d1117; overflow: hidden;
}
.mtp-head {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 5px 10px; background: #161b22; border-bottom: 1px solid #30363d;
}
.pane-dot { width: 8px; height: 8px; border-radius: 50%; background: #8b949e; flex: none; }
.pane-dot.ok { background: #3fb950; }
.pane-dot.bad { background: #f85149; }
.mtp-name {
  font-size: 12px; font-weight: 600; color: #e6edf3;
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mtp-status { font-size: 11px; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mtp-status.ok { color: #3fb950; }
.mtp-status.bad { color: #f85149; }
/* 底部留出安全边距：修复最后一行命令被浏览器底部遮挡的问题 */
.mtp-body { flex: 1; padding: 6px 6px 16px; min-height: 0; }
.mtp-body :deep(.xterm) { height: 100%; }
/* xterm overlay 滚动条宽度为 0 且不可拖拽，给可见细滚动条 */
.mtp-body :deep(.xterm-viewport) {
  background-color: #0d1117 !important;
  scrollbar-width: thin;
  scrollbar-color: #3b4654 transparent;
  scrollbar-gutter: stable;
}
.mtp-body :deep(.xterm-viewport::-webkit-scrollbar) { width: 9px; }
.mtp-body :deep(.xterm-viewport::-webkit-scrollbar-track) { background: transparent; }
.mtp-body :deep(.xterm-viewport::-webkit-scrollbar-thumb) { background: #39424e; border-radius: 6px; border: 2px solid #0d1117; }
.mtp-body :deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) { background: #55606e; }
</style>
