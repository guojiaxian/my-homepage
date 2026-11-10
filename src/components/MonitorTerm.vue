<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  hostId: { type: String, default: '' },
  hostName: { type: String, default: '' },
  /* 抽屉显隐由父级控制：关闭仅隐藏，不销毁终端会话，重新打开保留上次内容 */
  open: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])

const container = ref(null)
const status = ref('')
const statusCls = ref('')
const full = ref(false)
let term = null, ws = null, fit = null, loaded = false, curHost = ''

function setStatus(txt, cls = '') { status.value = txt; statusCls.value = cls }

async function connect() {
  if (!props.hostId) return
  curHost = props.hostId
  setStatsCleanup()
  container.value.innerHTML = ''
  setStatus('连接中…')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    if (!loaded) {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      await import('@xterm/xterm/css/xterm.css')
      loaded = true
      globalThis.__xtermCtor = { Terminal, FitAddon }
    }
    const { Terminal, FitAddon } = globalThis.__xtermCtor
    term = new Terminal({
      fontFamily: "'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: 13.5,
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#4493f8', selectionBackground: '#264f78' },
      cursorBlink: !reducedMotion,
      scrollback: 5000,
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container.value)
    fit.fit()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/api/terminal?host=${encodeURIComponent(props.hostId)}&cols=${term.cols}&rows=${term.rows}`)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => setStatus(`已连接 ${props.hostId}`, 'ok')
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return }
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'error') { setStatus('错误：' + msg.message, 'bad'); term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`) }
      } catch { /* 普通输入 */ }
    }
    ws.onclose = (ev) => { if (ws) setStatus(ev.reason ? `已断开（${ev.reason}）` : '已断开', 'bad') }
    ws.onerror = () => setStatus('连接失败（未登录或网关不可达）', 'bad')
    term.onData((d) => { if (ws && ws.readyState === 1) ws.send(d) })
    term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })) })
    term.focus()
  } catch (e) {
    setStatus('终端加载失败：' + e.message, 'bad')
  }
}
function setStatsCleanup() {
  if (ws) { try { ws.close() } catch { /* 已关 */ } ws = null }
  if (term) { try { term.dispose() } catch { /* 已释放 */ } term = null }
}
function onKeydown(e) {
  if (e.key !== 'Escape') return
  if (!full.value) { emit('close'); return }
  e.preventDefault()
  e.stopPropagation()
  toggleFull() // 全屏时 ESC 还原窗口（拦截不让进 shell）
}
async function toggleFull() {
  full.value = !full.value
  await nextTick()
  // 容器尺寸变化后重排 xterm 并把新行列同步给服务端（term.onResize 已接 WS resize 帧）
  requestAnimationFrame(() => { try { fit && fit.fit() } catch { /* 忽略 */ } })
  setTimeout(() => { try { fit && fit.fit(); term && term.focus() } catch { /* 忽略 */ } }, 80)
}
function popout() {
  /* 弹出窗口需要独立会话：先释放抽屉会话，避免同一主机并发占用 */
  setStatsCleanup()
  curHost = ''
  emit('close')
  window.open(`/monitor/terminal.html?host=${encodeURIComponent(props.hostId)}`, '_blank', 'width=980,height=640')
}

/* 重新显示时只重排/聚焦，不重连；会话已被服务端关闭（如空闲超时）时仍保留历史输出 */
async function refitFocus() {
  await nextTick()
  requestAnimationFrame(() => { try { fit && fit.fit() } catch { /* 忽略 */ } })
  setTimeout(() => { try { fit && fit.fit(); term && term.focus() } catch { /* 忽略 */ } }, 80)
}

watch(() => props.hostId, (v) => { if (v && props.open) connect() })
watch(() => props.open, (v) => {
  if (!v) { try { term && term.blur() } catch { /* 忽略 */ } return }
  // 切换过主机或会话已被释放时才新建；同一主机再次打开保留原会话与输出
  if (!term || curHost !== props.hostId) connect()
  else refitFocus()
}, { flush: 'post' })
onMounted(() => { if (props.open) connect() })
onBeforeUnmount(setStatsCleanup)

function onResizeWin() { if (fit) { try { fit.fit() } catch { /* 忽略 */ } } }
window.addEventListener('resize', onResizeWin)
// 捕获阶段监听：xterm 的 textarea 会吞 Escape（冒泡阶段收不到）；全屏时 ESC 还原窗口
window.addEventListener('keydown', onKeydown, true)
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResizeWin)
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div class="mon-term-mask" v-show="open && !full" @click="emit('close')" />
    <div class="mon-term-drawer" v-show="open" :class="{ full }">
      <div class="mon-term-head">
        <span class="t-title">终端 · {{ hostName || hostId }}</span>
        <span class="t-status" :class="statusCls">{{ status }}</span>
        <span class="spacer" />
        <button class="mini-btn" @click="connect">重连</button>
        <button class="mini-btn" @click="popout">弹出窗口</button>
      <button class="mini-btn" @click="toggleFull">{{ full ? '还原窗口' : '全屏' }}</button>
        <button class="mini-btn" @click="emit('close')">✕ 关闭</button>
      </div>
      <div ref="container" class="mon-term-body" />
    </div>
  </Teleport>
</template>

<style scoped>
.mon-term-mask { position: fixed; inset: 0; background: rgb(16 24 40 / 0.35); z-index: 55; }
.mon-term-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(920px, 96vw);
  background: var(--bg-soft); z-index: 60; border-left: 1px solid var(--border);
  box-shadow: -12px 0 40px rgb(16 24 40 / 0.18);
  display: flex; flex-direction: column;
  animation: monTermIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes monTermIn { from { transform: translateX(30px); opacity: 0; } to { transform: none; opacity: 1; } }
.mon-term-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.t-title { font-weight: 600; }
.t-status { font-size: 12.5px; color: var(--text-2); }
.t-status.ok { color: var(--green); }
.t-status.bad { color: var(--red); }
.spacer { flex: 1; }
.mini-btn { border: 1px solid var(--border); background: var(--bg-soft); border-radius: 6px; padding: 2px 8px; font-size: 12.5px; cursor: pointer; color: var(--text-2); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.mon-term-body { flex: 1; padding: 8px; background: #0d1117; }
.mon-term-drawer.full { inset: 0; width: 100vw; height: 100vh; border-left: 0; }
.mon-term-body :deep(.xterm) { height: 100%; }
@media (prefers-reduced-motion: reduce) { .mon-term-drawer { animation: none; } }
@media (max-width: 760px) { .mon-term-drawer { width: 100vw; } }
</style>
