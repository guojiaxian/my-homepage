<script setup>
import { reactive, ref, watch } from 'vue'
import { monApi, fmtTime } from '../lib/monitor-api.js'
import MonitorHostEdit from './MonitorHostEdit.vue'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close', 'saved'])

const tip = ref('')
const tipCls = ref('ok')
const auditRows = ref([])
const saving = ref(false)
const editIdx = ref(-1) // 嵌套编辑弹窗：当前主机下标，-1 关闭

const cfg = reactive({
  hosts: [],
  trackedDirs: [],
  thresholds: {},
  collect: {},
  terminal: {},
  webhookUrl: '',
})

function ok(msg) { tip.value = msg; tipCls.value = 'ok' }
function bad(msg) { tip.value = msg; tipCls.value = 'bad' }

async function load() {
  tip.value = ''
  editIdx.value = -1
  try {
    const c = await monApi('/api/monitor/config')
    const data = JSON.parse(JSON.stringify(c))
    // 本机主机必须有 terminal 子对象（编辑表单直接绑定其字段）
    for (const h of data.hosts || []) {
      if (h.type === 'local' && !h.terminal) {
        h.terminal = { host: '127.0.0.1', port: 22, username: 'root', authType: 'key', keyPath: '' }
      }
    }
    Object.assign(cfg, data)
    const a = await monApi('/api/monitor/audit?limit=50')
    auditRows.value = a.rows || []
  } catch (e) { bad('加载失败：' + e.message) }
}
watch(() => props.open, (v) => { if (v) load() })

function addHost() {
  cfg.hosts.push({ id: 'host-' + Math.random().toString(36).slice(2, 6), name: '新主机', type: 'ssh', group: '内网', address: '', port: 22, username: 'root', authType: 'key', keyPath: '', trackedDirs: [] })
  editIdx.value = cfg.hosts.length - 1 // 创建后立即打开编辑弹窗
}
function delHost(i) { cfg.hosts.splice(i, 1) }
function hostSummary(h) {
  const kind = h.type === 'local' ? '本机' : 'SSH 远程'
  const addr = h.type === 'ssh' ? `${h.address || '未配置地址'}:${h.port || 22}` : (h.address || '127.0.0.1')
  const n = (h.effectiveDirs || h.trackedDirs || []).length
  /* 双向同步徽标：syncSource='apps' = 方向一创建；appSync = 已勾选同步到应用中心（方向二） */
  const sync = [
    h.syncSource === 'apps' ? '来自应用中心' : '',
    h.appSync ? '同步到应用中心' : '',
  ].filter(Boolean).join(' + ')
  return `${kind} · ${h.group || '未分组'} · ${addr}${n ? ` · ${n} 个跟踪目录` : ''}${sync ? ` · ${sync}` : ''}`
}

function addDir() {
  const p = prompt('输入要跟踪的绝对目录路径（如 /opt/myapp）：')
  if (!p) return
  if (!p.startsWith('/')) { alert('必须是绝对路径'); return }
  if (p === '/') { alert('不允许跟踪根目录（不越界采集）'); return }
  if (p.endsWith('/')) p = p.replace(/\/+$/, '')
  if (cfg.trackedDirs.some((d) => d.path === p)) { alert('该目录已在列表中'); return }
  cfg.trackedDirs.push({ path: p, name: p.split('/').filter(Boolean).pop() || p, source: 'custom' })
}
function delDir(i) { cfg.trackedDirs.splice(i, 1) }

async function save() {
  saving.value = true
  try {
    await monApi('/api/monitor/config', {
      method: 'PUT',
      body: {
        hosts: cfg.hosts,
        trackedDirs: cfg.trackedDirs,
        thresholds: cfg.thresholds,
        collect: cfg.collect,
        terminal: cfg.terminal,
        webhookUrl: cfg.webhookUrl?.trim() || '',
      },
    })
    ok('已保存并热加载 ✓')
    emit('saved')
    setTimeout(() => { if (tip.value.startsWith('已保存')) tip.value = '' }, 1500)
  } catch (e) { bad('保存失败：' + e.message) } finally { saving.value = false }
}

const oldPw = ref('')
const newPw = ref('')
async function changePw() {
  try {
    await monApi('/api/monitor/password', { method: 'POST', body: { oldPassword: oldPw.value, newPassword: newPw.value } })
    oldPw.value = ''; newPw.value = ''
    ok('密码已修改，请重新登录')
    setTimeout(() => { emit('close'); location.reload() }, 900)
  } catch (e) { bad('修改失败：' + e.message) }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mon-modal-mask" @click.self="emit('close')">
      <div class="mon-modal">
        <div class="mon-modal-head">
          <h2>监控设置</h2>
          <span class="save-tip" :class="tipCls">{{ tip }}</span>
          <button class="mini-btn" @click="emit('close')">✕</button>
        </div>
        <div class="mon-modal-body">
          <section class="msec">
            <h3>纳管主机 <span class="hcount">{{ cfg.hosts.length }}</span></h3>
            <div class="host-list">
              <div v-for="(h, i) in cfg.hosts" :key="h.id" class="host-row" :class="{ open: editIdx === i }" @click="editIdx = i">
                <span class="hr-ico" :class="{ local: h.type === 'local' }">{{ h.type === 'local' ? '🖥' : '☁' }}</span>
                <span class="hr-main">
                  <span class="hr-name">{{ h.name || h.id }} <code>{{ h.id }}</code></span>
                  <span class="hr-sum">{{ hostSummary(h) }}</span>
                </span>
                <span v-if="h.type === 'local'" class="hr-lock" title="本机主机不可删除">内置</span>
                <span class="hr-arrow">›</span>
              </div>
              <p v-if="!cfg.hosts.length" class="sub" style="padding:8px 2px">暂无主机，点击下方添加。</p>
            </div>
            <button class="mini-btn" style="margin-top:8px" @click="addHost">＋添加主机</button>
            <p class="sub" style="margin:8px 0 0">点击主机条目编辑连接信息与跟踪目录；弹窗内修改为草稿，由底部「保存配置」统一提交。</p>
          </section>

          <section v-if="cfg.trackedDirs.length" class="msec">
            <h3>全局自定义目录（对所有主机生效）</h3>
            <p class="sub" style="margin:0 0 8px">通常无需在此添加：本机的主页登记应用目录会自动并入，远程主机请在主机编辑弹窗里添加该机目录。</p>
            <div v-for="(d, i) in cfg.trackedDirs" :key="d.path" class="dir-row">
              <span class="d-path">{{ d.path }}</span>
              <span class="d-src">自定义</span>
              <button class="mini-btn danger" @click="delDir(i)">移除</button>
            </div>
            <button class="mini-btn" @click="addDir">＋添加目录</button>
          </section>

          <section class="msec">
            <h3>告警阈值</h3>
            <div class="form-grid">
              <label class="fitem"><span>CPU %</span><input v-model.number="cfg.thresholds.cpuPct" type="number" step="0.1" /></label>
              <label class="fitem"><span>内存 %</span><input v-model.number="cfg.thresholds.memPct" type="number" step="0.1" /></label>
              <label class="fitem"><span>磁盘 %</span><input v-model.number="cfg.thresholds.diskPct" type="number" step="0.1" /></label>
              <label class="fitem"><span>每核负载</span><input v-model.number="cfg.thresholds.loadPerCore" type="number" step="0.1" /></label>
              <label class="fitem"><span>持续分钟</span><input v-model.number="cfg.thresholds.sustainMin" type="number" step="0.5" /></label>
            </div>
          </section>

          <section class="msec">
            <h3>采集与终端</h3>
            <div class="form-grid">
              <label class="fitem"><span>本机采集间隔(秒)</span><input v-model.number="cfg.collect.localIntervalSec" type="number" /></label>
              <label class="fitem"><span>远程采集间隔(秒)</span><input v-model.number="cfg.collect.remoteIntervalSec" type="number" /></label>
              <label class="fitem"><span>历史保留(天)</span><input v-model.number="cfg.collect.retentionDays" type="number" /></label>
              <label class="fitem"><span>容器映射刷新(秒)</span><input v-model.number="cfg.collect.dockerRefreshSec" type="number" /></label>
              <label class="fitem"><span>终端空闲超时(分)</span><input v-model.number="cfg.terminal.idleTimeoutMin" type="number" /></label>
              <label class="fitem"><span>单会话上限(分)</span><input v-model.number="cfg.terminal.maxSessionMin" type="number" /></label>
              <label class="fitem"><span>每主机并发会话</span><input v-model.number="cfg.terminal.maxSessionsPerHost" type="number" /></label>
              <label class="fitem"><span>命令行审计</span>
                <span class="check-row"><input v-model="cfg.terminal.recordCommands" type="checkbox" /> 记录回车提交的命令</span>
              </label>
              <label class="fitem span2"><span>告警 Webhook（POST JSON，留空关闭）</span><input v-model="cfg.webhookUrl" type="text" placeholder="https://..." /></label>
            </div>
          </section>

          <section class="msec">
            <h3>修改访问密码</h3>
            <div class="form-grid">
              <label class="fitem"><span>旧密码</span><input v-model="oldPw" type="password" autocomplete="current-password" /></label>
              <label class="fitem"><span>新密码</span><input v-model="newPw" type="password" autocomplete="new-password" /></label>
              <label class="fitem"><span>&nbsp;</span><button class="mini-btn" @click="changePw">修改密码</button></label>
            </div>
          </section>

          <section class="msec">
            <h3>最近审计记录（会话 / 鉴权 / 配置变更）</h3>
            <div class="table-scroll low">
              <table class="audit-table">
                <thead><tr><th>时间</th><th>事件</th><th>主机</th><th>IP</th><th>时长</th><th>备注</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in auditRows" :key="i">
                    <td class="num">{{ fmtTime(r.ts) }}</td>
                    <td>{{ r.event }}</td>
                    <td>{{ r.host || '-' }}</td>
                    <td class="num">{{ r.ip || '-' }}</td>
                    <td class="num">{{ r.durationSec != null ? r.durationSec + 's' : '-' }}</td>
                    <td>{{ r.reason || (r.keys && r.keys.join(',')) || (r.commands && r.commands.slice(-3).join(' ; ')) || '' }}</td>
                  </tr>
                  <tr v-if="!auditRows.length"><td colspan="6" class="empty">暂无记录</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <div class="modal-foot">
            <button class="ghost-btn" @click="emit('close')">取消</button>
            <button class="primary-btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 嵌套主机编辑弹窗（z-index 高于面板，草稿模式：修改留在 cfg，底部「保存配置」统一提交） -->
    <MonitorHostEdit
      :open="editIdx >= 0"
      :host="editIdx >= 0 ? cfg.hosts[editIdx] : { type: 'ssh' }"
      :deletable="editIdx >= 0 && cfg.hosts[editIdx]?.type === 'ssh'"
      @close="editIdx = -1"
      @del="delHost(editIdx); editIdx = -1"
    />
  </Teleport>
</template>

<script>
export default { name: 'MonitorSettings' }
</script>

<style scoped>
.mon-modal-mask { position: fixed; inset: 0; background: rgb(16 24 40 / 0.45); z-index: 70; display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; overflow: auto; }
.mon-modal { width: 780px; max-width: 100%; background: var(--bg-soft); border-radius: 14px; box-shadow: var(--shadow-hover); border: 1px solid var(--border); }
.mon-modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg-soft); border-radius: 14px 14px 0 0; z-index: 1; }
.mon-modal-head h2 { margin: 0; font-size: 16px; }
.save-tip { font-size: 13px; margin-left: auto; }
.save-tip.ok { color: var(--green); }
.save-tip.bad { color: var(--red); }
.mon-modal-body { padding: 16px 18px 22px; max-height: calc(100vh - 160px); overflow: auto; }
.msec { margin-bottom: 22px; }
.msec h3 { font-size: 14px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px dashed var(--border); }
.hcount { font-size: 12px; color: var(--text-2); font-weight: 400; margin-left: 4px; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.fitem { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.fitem span { font-size: 12px; color: var(--text-2); }
.fitem input, .fitem select { width: 100%; }
.fitem.span2 { grid-column: span 2; }
.check-row { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 6px 0; }
.check-row input { accent-color: var(--accent); }
.dir-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; background: var(--bg); }
.d-path { font-family: var(--mono); font-size: 12.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.d-src { font-size: 11px; border-radius: 999px; padding: 0 8px; background: var(--purple-soft); color: var(--purple); }
.table-scroll { max-height: 380px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.table-scroll.low { max-height: 240px; }
.audit-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.audit-table th, .audit-table td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; white-space: nowrap; }
.audit-table th { color: var(--text-2); font-weight: 500; position: sticky; top: 0; background: var(--bg-soft); }
.audit-table td.num { font-family: var(--mono); }
.empty { color: var(--text-2); text-align: center; padding: 16px; }
.modal-foot { display: flex; gap: 10px; justify-content: flex-end; }
.mini-btn { border: 1px solid var(--border); background: var(--bg-soft); border-radius: 6px; padding: 2px 8px; font-size: 12.5px; cursor: pointer; color: var(--text-2); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.mini-btn.danger:hover { border-color: var(--red); color: var(--red); }
.ghost-btn { border: 1px solid var(--border); background: var(--bg-soft); color: var(--text); border-radius: 8px; padding: 5px 14px; font-size: 13.5px; cursor: pointer; }
.ghost-btn:hover { border-color: var(--accent); color: var(--accent); }
.primary-btn { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 6px 16px; font-size: 13.5px; cursor: pointer; }
.primary-btn:hover { filter: brightness(1.06); }
.primary-btn:disabled { opacity: 0.6; cursor: default; }
.sub { color: var(--text-2); font-size: 12px; }
code { font-family: var(--mono); font-size: 11.5px; background: var(--bg-hover); border-radius: 4px; padding: 0 4px; }

/* ===== 纳管主机紧凑列表（点击行 → 嵌套编辑弹窗） ===== */
.host-list { display: flex; flex-direction: column; gap: 6px; }
.host-row {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 12px; background: var(--bg);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.host-row:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--bg-soft); }
.host-row.open { border-color: var(--accent); }
.hr-ico { width: 30px; height: 30px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 8px; font-size: 15px; background: var(--amber-soft); color: var(--amber); }
.hr-ico.local { background: var(--accent-soft); color: var(--accent); }
.hr-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.hr-name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hr-name code { font-weight: 400; }
.hr-sum { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hr-lock { font-size: 11px; border-radius: 999px; padding: 1px 8px; background: var(--bg-hover); color: var(--text-2); flex: none; }
.hr-arrow { color: var(--text-2); font-size: 16px; flex: none; line-height: 1; }
</style>
