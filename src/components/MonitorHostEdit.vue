<script setup>
import { computed, ref, watch } from 'vue'
import { monApi } from '../lib/monitor-api.js'

/* 单主机编辑弹窗，两处复用：
   · MonitorSettings（草稿模式）：直接改传入的响应式对象，由面板底部「保存配置」统一提交；
   · MonitorView 直连模式（详情页 ⚙ 进入）：direct=true，底部「保存」触发父级 PUT 全量配置。 */
const props = defineProps({
  open: { type: Boolean, default: false },
  host: { type: Object, required: true },
  direct: { type: Boolean, default: false }, // true = 弹窗内直接保存；false = 草稿（返回面板再保存）
  isNew: { type: Boolean, default: false }, // 新增主机允许编辑 id；已存在主机 id 只读
  deletable: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  err: { type: String, default: '' },
})
const emit = defineEmits(['close', 'save', 'del', 'saved'])

/* ---------- 自动部署：密码 → 免密 + Agent 安装（中心代劳） ---------- */
const provPw = ref('')
const provBusy = ref(false)
const provSteps = ref([])
const provTip = ref('')
const provTipCls = ref('ok')
async function doProvision() {
  if (!props.host.address) { provTip.value = '请先填写目标机地址'; provTipCls.value = 'bad'; return }
  if (!props.host.username) { provTip.value = '请先填写用户名'; provTipCls.value = 'bad'; return }
  if (!provPw.value) { provTip.value = '请输入目标机密码'; provTipCls.value = 'bad'; return }
  provBusy.value = true; provSteps.value = []; provTip.value = ''
  try {
    const r = await monApi('/api/monitor/hosts/provision', {
      method: 'POST',
      body: { host: JSON.parse(JSON.stringify(props.host)), password: provPw.value },
    })
    provSteps.value = r.steps || []
    if (r.host) Object.assign(props.host, r.host) // keyPath/mode 等同步回草稿
    provPw.value = ''
    provTip.value = '部署完成 ✓（免密与 Agent 均已配置，等待首个推送）'
    provTipCls.value = 'ok'
    emit('saved')
  } catch (e) {
    provTip.value = '部署失败：' + e.message
    provTipCls.value = 'bad'
  } finally { provBusy.value = false }
}

/* 分组下拉：保留历史自定义值，避免选择后丢失 */
const groupOptions = computed(() => {
  const base = ['内网', '公网']
  const g = String(props.host?.group || '').trim()
  return g && !base.includes(g) ? [...base, g] : base
})

/* 已同步状态：sync-check 的配对结果优先；接口不可用时退回同步标记 */
const syncPair = ref(null)
const syncCandidate = ref(null)
async function loadSyncPair() {
  syncPair.value = null
  syncCandidate.value = null
  try {
    const d = await monApi('/api/monitor/sync-check')
    const id = props.host?.id
    syncPair.value = (d.pairs || []).find((p) => p.hostId === id) || null
    syncCandidate.value = (d.candidates || []).find((c) => c.hostId === id) || null
  } catch { /* 接口不可用时仅按标记判断 */ }
}
const syncInfo = computed(() => {
  const h = props.host
  if (!h) return null
  if (syncPair.value) return { desc: `与「${syncPair.value.appName || syncPair.value.appId}」配对，主机信息变更自动跟随` }
  if (h.syncSource === 'apps') return { desc: '由应用中心创建，名称 / 分组 / 地址自动跟随' }
  if (h.appSync) return { desc: '主机信息变更会自动同步到应用中心' }
  return null
})

/* 兜底：本机主机必须有 terminal 子对象（表单直接绑定其字段） */
watch(
  () => props.open,
  (v) => {
    if (v && props.host?.type === 'local' && !props.host.terminal) {
      props.host.terminal = { host: '127.0.0.1', port: 22, username: 'root', authType: 'key', keyPath: '' }
    }
    if (v && props.host?.type === 'ssh' && !props.host.mode) props.host.mode = 'ssh'
    if (v) loadSyncPair()
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
  if ((props.host.effectiveDirs || []).some((d) => d.path === clean)) {
    alert('该目录已自动并入（主页登记 / 全局目录），无需重复添加')
    return
  }
  const list = h.trackedDirs || (h.trackedDirs = [])
  if (list.some((d) => d.path === clean)) { alert('该目录已在列表中'); return }
  list.push({ path: clean, source: 'host' })
}
function delDir(i) { props.host.trackedDirs.splice(i, 1) }

/* 自动并入的只读目录（本机=主页登记；全部主机=全局自定义），与自有目录分开展示 */
const inheritedDirs = computed(() => {
  const own = new Set((props.host.trackedDirs || []).map((d) => d.path))
  return (props.host.effectiveDirs || []).filter((d) => d.source !== 'host' && !own.has(d.path))
})
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
          <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
        </div>
        <div class="mhe-body">
          <div class="form-grid">
            <label class="fitem">
              <span>主机标识 id{{ isNew ? '' : '（不可修改）' }}</span>
              <input
                v-model="host.id"
                type="text"
                class="mono"
                spellcheck="false"
                placeholder="如 my-server"
                :readonly="!isNew"
                :title="isNew ? '建议使用目录名或短标识，创建后不可修改' : '密钥与审计依赖此 id，创建后不可修改'"
              />
            </label>
            <label class="fitem"><span>名称</span><input v-model="host.name" placeholder="显示名称" /></label>
            <label class="fitem"><span>分组</span>
              <select v-model="host.group" title="内网 = 外机（绿）/ 公网（橙）；本机固定蓝色">
                <option v-for="g in groupOptions" :key="g" :value="g">{{ g }}</option>
              </select>
            </label>
            <template v-if="host.type === 'ssh'">
              <label class="fitem"><span>地址</span><input v-model="host.address" class="mono" placeholder="IP 或域名" /></label>
              <label class="fitem"><span>SSH 端口</span><input v-model.number="host.port" type="number" min="1" max="65535" /></label>
              <label class="fitem"><span>用户名</span><input v-model="host.username" placeholder="root" /></label>
              <label class="fitem"><span>认证</span>
                <select v-model="host.authType"><option value="key">密钥</option><option value="password">密码</option></select>
              </label>
              <label v-if="host.authType === 'key'" class="fitem span2"><span>私钥路径（0600）</span><input v-model="host.keyPath" class="mono" placeholder="/root/.ssh/id_rsa" /></label>
              <div v-else class="fitem span2"><span>密码凭据</span><div class="cred-box">密码由「自动部署」或 CLI 加密保存，此处不显示明文。</div></div>
              <label class="fitem span2"><span>采集方式</span>
                <select v-model="host.mode">
                  <option value="ssh">SSH 拉取（中心每 20s 短连接采集，需密钥/凭据）</option>
                  <option value="agent">Agent 推送（目标机常驻 agent，监控零 SSH 连接）</option>
                </select>
              </label>
            </template>
            <template v-else>
              <label class="fitem"><span>展示地址</span><input v-model="host.address" class="mono" placeholder="10.8.11.4" /></label>
              <label class="fitem"><span>终端主机</span><input v-model="host.terminal.host" class="mono" placeholder="127.0.0.1" /></label>
              <label class="fitem"><span>终端端口</span><input v-model.number="host.terminal.port" type="number" min="1" max="65535" /></label>
              <label class="fitem"><span>终端用户</span><input v-model="host.terminal.username" placeholder="root" /></label>
              <label class="fitem"><span>认证</span>
                <select v-model="host.terminal.authType"><option value="key">密钥</option><option value="password">密码</option></select>
              </label>
              <label v-if="host.terminal.authType === 'key'" class="fitem span2"><span>私钥路径</span><input v-model="host.terminal.keyPath" class="mono" placeholder="/root/.ssh/id_rsa" /></label>
              <div v-else class="fitem span2"><span>密码凭据</span><div class="cred-box">密码由「自动部署」或 CLI 加密保存，此处不显示明文。</div></div>
            </template>
          </div>

          <div v-if="host.type === 'ssh'" class="he-dirs">
            <template v-if="syncInfo">
              <div class="sync-status">
                <span class="sync-dot">✓</span>
                <b>已同步应用中心</b>
                <span class="sub">{{ syncInfo.desc }}</span>
              </div>
            </template>
            <template v-else>
              <label class="sync-chk">
                <input v-model="host.appSync" type="checkbox" />
                <span>同步到应用中心</span>
              </label>
              <p class="sub" style="margin:4px 0 0">
                勾选后在应用中心自动创建/更新同名远程应用（健康接口默认 http://地址/，分组按公网/内网映射，主机信息变更自动跟随）；取消勾选不会删除已创建的条目，需在应用设置中手动删除。
              </p>
              <p v-if="syncCandidate" class="sync-cand">
                应用中心已有同地址应用「{{ syncCandidate.appName || syncCandidate.appId }}」，勾选并保存即可建立同步。
              </p>
            </template>
          </div>

          <div v-if="host.type === 'ssh'" class="he-dirs">
            <div class="sub" style="margin-bottom:4px">
              自动部署：输入目标机密码，中心自动 SSH 完成——① 免密密钥分发 ② Agent 安装并启动 ③ 切换推送模式（密码仅本次使用，另加密存档备用）
            </div>
            <div class="dir-row" style="align-items:center">
              <input
                v-model="provPw"
                type="password"
                placeholder="目标机密码"
                autocomplete="new-password"
                style="flex:1;margin:0"
                @keydown.enter="doProvision"
              />
              <button class="mini-btn" :disabled="provBusy" @click="doProvision">{{ provBusy ? '部署中…' : '自动安装 Agent 并配置免密' }}</button>
            </div>
            <ol v-if="provSteps.length" class="prov-steps">
              <li v-for="(st, i) in provSteps" :key="i">{{ st }}</li>
            </ol>
            <p v-if="provTip" class="sub" :style="{ color: provTipCls === 'ok' ? 'var(--green)' : 'var(--red)' }">{{ provTip }}</p>
          </div>
          <p v-if="host.note" class="sub">{{ host.note }}</p>

          <div class="he-dirs">
            <div class="sub" style="margin-bottom:4px">
              该主机跟踪目录（目录级资源统计{{ host.type === 'local' ? '；主页登记的应用目录已自动并入' : '；全局目录已自动并入' }}）
            </div>
            <div v-for="d in inheritedDirs" :key="'in-' + d.path" class="dir-row inherited">
              <span class="d-path" :title="d.path">{{ d.source === 'container' ? d.name : d.path }}</span>
              <span class="d-src" :class="d.source">{{ d.source === 'homepage' ? '主页登记' : d.source === 'container' ? '自动发现' : '全局' }}</span>
            </div>
            <div v-for="(d, di) in host.trackedDirs" :key="d.path" class="dir-row">
              <span class="d-path">{{ d.path }}</span>
              <span class="d-src">主机目录</span>
              <button class="mini-btn danger" @click="delDir(di)">移除</button>
            </div>
            <p v-if="!inheritedDirs.length && !(host.trackedDirs || []).length" class="sub">暂无跟踪目录</p>
            <button class="mini-btn" @click="addDir">＋添加该主机目录</button>
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
.mhe-mask { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); backdrop-filter: blur(3px); z-index: 80; display: flex; align-items: center; justify-content: center; padding: 24px; }
.mhe { width: 560px; max-width: 100%; max-height: 90vh; display: flex; flex-direction: column; background: var(--bg); border-radius: 14px; box-shadow: var(--shadow-hover); border: 1px solid var(--border); }
.mhe-head { display: flex; align-items: center; gap: 8px; padding: 13px 16px; border-bottom: 1px solid var(--border); flex: none; }
.mhe-head h2 { margin: 0; font-size: 15px; }
.mhe-head code { font-family: var(--mono); font-size: 11.5px; color: var(--text-2); background: var(--bg-hover); border-radius: 4px; padding: 1px 6px; }
.mhe-body { padding: 14px 16px 6px; flex: 1 1 auto; min-height: 0; overflow: auto; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }
.fitem { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); min-width: 0; }
.fitem > span { font-size: 12px; color: var(--text-2); }
.fitem input, .fitem select {
  font: inherit; font-size: 13.5px; color: var(--text);
  background-color: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 10px; outline: none; width: 100%; min-width: 0;
  transition: border-color 0.15s ease;
}
.fitem input:focus, .fitem select:focus { border-color: var(--accent); }
.fitem input:read-only { background: var(--bg-hover); color: var(--text-2); cursor: default; }
.fitem input::placeholder { color: var(--text-2); opacity: 0.55; }
.fitem select {
  appearance: none; cursor: pointer; padding-right: 30px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; background-size: 10px;
}
.fitem.span2 { grid-column: 1 / -1; }
.cred-box { font-size: 12.5px; color: var(--text-2); line-height: 1.55; background: var(--bg-hover); border: 1px dashed var(--border); border-radius: 8px; padding: 7px 10px; }
.he-dirs { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--border); }
.sync-chk { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; cursor: pointer; }
.sync-chk input { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.sync-status {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 11px; border: 1px solid color-mix(in srgb, var(--green) 35%, var(--border));
  background: var(--green-soft); border-radius: 8px;
}
.sync-dot {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--green); color: #fff; font-size: 11px; font-weight: 700;
}
.sync-status b { font-size: 13px; color: var(--green); }
.sync-status .sub { font-size: 12px; }
.sync-cand { margin: 6px 0 0; font-size: 12px; color: var(--accent); }
.prov-steps { margin: 8px 0 4px; padding-left: 20px; color: var(--text-2); font-size: 12px; }
.prov-steps li { margin: 2px 0; }
.dir-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; background: var(--bg); }
.dir-row.inherited { background: transparent; border-style: dashed; }
.d-path { font-family: var(--mono); font-size: 12.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.d-src { font-size: 11px; border-radius: 999px; padding: 0 8px; background: var(--purple-soft); color: var(--purple); flex: none; }
.d-src.homepage { background: var(--accent-soft); color: var(--accent); }
.d-src.custom { background: var(--amber-soft); color: var(--amber); }
.d-src.container { background: var(--teal-soft); color: var(--teal); }
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
@media (max-width: 560px) {
  .form-grid { grid-template-columns: 1fr; }
  .fitem.span2 { grid-column: auto; }
}
</style>
