<script setup>
import { ref, watch } from 'vue'
import { monApi } from '../lib/monitor-api.js'

/* 单主机编辑弹窗，两处复用：
   · MonitorSettings（草稿模式）：直接改传入的响应式对象，由面板底部「保存配置」统一提交；
   · MonitorView 直连模式（详情页 ⚙ 进入）：direct=true，底部「保存」触发父级 PUT 全量配置。 */
const props = defineProps({
  open: { type: Boolean, default: false },
  host: { type: Object, required: true },
  direct: { type: Boolean, default: false }, // true = 弹窗内直接保存；false = 草稿（返回面板再保存）
  deletable: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  err: { type: String, default: '' },
})
const emit = defineEmits(['close', 'save', 'del'])

/* 兜底：本机主机必须有 terminal 子对象（表单直接绑定其字段） */
watch(
  () => props.open,
  (v) => {
    if (v && props.host?.type === 'local' && !props.host.terminal) {
      props.host.terminal = { host: '127.0.0.1', port: 22, username: 'root', authType: 'key', keyPath: '' }
    }
    if (v && props.host?.type === 'ssh' && !props.host.mode) props.host.mode = 'ssh'
  },
  { immediate: true },
)

/* ---------- Agent 推送模式：一键安装命令 ---------- */
const installCmd = ref('')
const installTip = ref('')
const installBusy = ref(false)
async function genInstall() {
  installBusy.value = true
  installTip.value = ''
  try {
    const r = await monApi(`/api/monitor/hosts/${encodeURIComponent(props.host.id)}/agent-install`)
    installCmd.value = r.cmd
  } catch (e) { installTip.value = '生成失败：' + e.message } finally { installBusy.value = false }
}
async function copyInstall() {
  try { await navigator.clipboard.writeText(installCmd.value); installTip.value = '已复制，到目标服务器以 root 执行 ✓' }
  catch {
    const ta = document.createElement('textarea')
    ta.value = installCmd.value; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy'); installTip.value = '已复制，到目标服务器以 root 执行 ✓' } catch { installTip.value = '复制失败，请手动选择文本' }
    ta.remove()
  }
  setTimeout(() => { installTip.value = '' }, 2500)
}

function addDir() {
  const h = props.host
  const p = prompt(`输入 ${h.name || h.id} 上要跟踪的绝对目录路径（如 /opt/myapp）：`)
  if (!p) return
  if (!p.startsWith('/')) { alert('必须是绝对路径'); return }
  if (p === '/') { alert('不允许跟踪根目录（不越界采集）'); return }
  const clean = p.replace(/\/+$/, '')
  const list = h.trackedDirs || (h.trackedDirs = [])
  if (list.some((d) => d.path === clean)) { alert('该目录已在列表中'); return }
  list.push({ path: clean, source: 'host' })
}
function delDir(i) { props.host.trackedDirs.splice(i, 1) }
function onDelete() {
  if (confirm(`删除主机 ${props.host.id}？（保存后生效）`)) emit('del')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && host" class="mhe-mask" @click.self="emit('close')">
      <div class="mhe">
        <div class="mhe-head">
          <h2>{{ host.type === 'local' ? '本机' : 'SSH 远程' }} · {{ host.name || host.id }}</h2>
          <code>{{ host.id }}</code>
          <span class="grow" />
          <button class="mini-btn" @click="emit('close')">✕</button>
        </div>
        <div class="mhe-body">
          <div class="form-grid">
            <label class="fitem"><span>名称</span><input v-model="host.name" type="text" /></label>
            <label class="fitem"><span>分组（内网=蓝 / 公网=橙）</span><input v-model="host.group" type="text" /></label>
            <template v-if="host.type === 'ssh'">
              <label class="fitem"><span>地址</span><input v-model="host.address" type="text" /></label>
              <label class="fitem"><span>SSH 端口</span><input v-model.number="host.port" type="number" /></label>
              <label class="fitem"><span>用户名</span><input v-model="host.username" type="text" /></label>
              <label class="fitem"><span>认证</span>
                <select v-model="host.authType"><option value="key">密钥</option><option value="password">密码</option></select>
              </label>
              <label class="fitem span2"><span>私钥路径（0600）</span><input v-model="host.keyPath" type="text" /></label>
              <label class="fitem span2"><span>采集方式</span>
                <select v-model="host.mode">
                  <option value="ssh">SSH 拉取（中心每 20s 短连接采集，需密钥/凭据）</option>
                  <option value="agent">Agent 推送（目标机常驻 agent，监控零 SSH 连接）</option>
                </select>
              </label>
            </template>
            <template v-else>
              <label class="fitem"><span>展示地址</span><input v-model="host.address" type="text" /></label>
              <label class="fitem"><span>终端主机</span><input v-model="host.terminal.host" type="text" /></label>
              <label class="fitem"><span>终端端口</span><input v-model.number="host.terminal.port" type="number" /></label>
              <label class="fitem"><span>终端用户</span><input v-model="host.terminal.username" type="text" /></label>
              <label class="fitem"><span>认证</span>
                <select v-model="host.terminal.authType"><option value="key">密钥</option><option value="password">密码</option></select>
              </label>
              <label class="fitem span2"><span>私钥路径</span><input v-model="host.terminal.keyPath" type="text" /></label>
            </template>
          </div>
          <p v-if="host.note" class="sub">{{ host.note }}</p>

          <div class="he-dirs">
            <div class="sub" style="margin-bottom:4px">
              该主机跟踪目录（目录级资源统计{{ host.type === 'local' ? '；主页登记的应用目录已自动并入' : '' }}）
            </div>
            <div v-for="(d, di) in host.trackedDirs" :key="d.path" class="dir-row">
              <span class="d-path">{{ d.path }}</span>
              <span class="d-src">主机目录</span>
              <button class="mini-btn danger" @click="delDir(di)">移除</button>
            </div>
            <button class="mini-btn" @click="addDir">＋添加目录</button>
          </div>

          <div v-if="host.type === 'ssh' && host.mode === 'agent'" class="he-dirs">
            <div class="sub" style="margin-bottom:4px">
              Agent 一键安装（在目标服务器以 root 执行；安装后监控数据由 agent 推送，SSH 仅用于打开终端）
            </div>
            <div class="dir-row">
              <span class="d-path">{{ installCmd || '尚未生成安装命令' }}</span>
              <button class="mini-btn" :disabled="installBusy" @click="installCmd ? copyInstall() : genInstall()">
                {{ installBusy ? '生成中…' : installCmd ? '复制' : '生成安装命令' }}
              </button>
            </div>
            <p v-if="installTip" class="sub" :style="{ color: installTip.includes('复制') ? 'var(--green)' : 'var(--red)' }">{{ installTip }}</p>
          </div>

          <p v-if="host.type === 'ssh' && host.mode !== 'agent'" class="sub cred-tip">
            远程主机推荐密钥认证：先 <code>ssh-copy-id -i &lt;keyPath&gt;.pub {{ host.username }}@{{ host.address || 'host' }}</code> 分发公钥；密码认证经 AES-256-GCM 加密存储（CLI：<code>node scripts/monitor-server.mjs --set-cred {{ host.id }} --password-stdin</code>）。
          </p>
          <p v-if="host.type === 'ssh' && host.mode === 'agent'" class="sub cred-tip">
            Agent 模式下终端仍走 SSH（复用下方认证方式）；监控数据推送断流 >70 秒会显示离线。
          </p>
        </div>
        <div class="mhe-foot">
          <span v-if="err" class="err-tip">{{ err }}</span>
          <span v-else-if="!direct" class="sub">草稿模式：返回后由「保存配置」统一提交</span>
          <button v-if="deletable" class="mini-btn danger" @click="onDelete">删除此主机</button>
          <span class="grow" />
          <button class="ghost-btn" @click="emit('close')">{{ direct ? '取消' : '完成' }}</button>
          <button v-if="direct" class="primary-btn" :disabled="saving" @click="emit('save')">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script>
export default { name: 'MonitorHostEdit' }
</script>

<style scoped>
.grow { flex: 1; }
.sub { color: var(--text-2); font-size: 12px; }
.mhe-mask { position: fixed; inset: 0; background: rgb(16 24 40 / 0.45); z-index: 80; display: flex; align-items: flex-start; justify-content: center; padding: 60px 16px; overflow: auto; }
.mhe { width: 560px; max-width: 100%; background: var(--bg-soft); border-radius: 14px; box-shadow: var(--shadow-hover); border: 1px solid var(--border); }
.mhe-head { display: flex; align-items: center; gap: 8px; padding: 13px 16px; border-bottom: 1px solid var(--border); }
.mhe-head h2 { margin: 0; font-size: 15px; }
.mhe-head code { font-family: var(--mono); font-size: 11.5px; color: var(--text-2); background: var(--bg-hover); border-radius: 4px; padding: 1px 6px; }
.mhe-body { padding: 14px 16px 6px; max-height: calc(100vh - 260px); overflow: auto; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.fitem { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.fitem span { font-size: 12px; color: var(--text-2); }
.fitem input, .fitem select { width: 100%; }
.fitem.span2 { grid-column: span 2; }
.he-dirs { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--border); }
.dir-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; background: var(--bg); }
.d-path { font-family: var(--mono); font-size: 12.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.d-src { font-size: 11px; border-radius: 999px; padding: 0 8px; background: var(--purple-soft); color: var(--purple); }
.cred-tip { margin: 10px 0 8px; line-height: 1.6; }
code { font-family: var(--mono); font-size: 11.5px; background: var(--bg-hover); border-radius: 4px; padding: 0 4px; }
.mhe-foot { display: flex; align-items: center; gap: 10px; padding: 12px 16px 14px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.err-tip { color: var(--red); font-size: 12.5px; }
.mini-btn { border: 1px solid var(--border); background: var(--bg-soft); border-radius: 6px; padding: 2px 8px; font-size: 12.5px; cursor: pointer; color: var(--text-2); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.mini-btn.danger:hover { border-color: var(--red); color: var(--red); }
.ghost-btn { border: 1px solid var(--border); background: var(--bg-soft); color: var(--text); border-radius: 8px; padding: 5px 14px; font-size: 13.5px; cursor: pointer; }
.ghost-btn:hover { border-color: var(--accent); color: var(--accent); }
.primary-btn { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 6px 16px; font-size: 13.5px; cursor: pointer; }
.primary-btn:hover { filter: brightness(1.06); }
.primary-btn:disabled { opacity: 0.6; cursor: default; }
</style>
