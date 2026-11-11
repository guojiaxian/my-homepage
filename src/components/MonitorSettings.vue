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
  cfg.hosts.push({ id: 'host-' + Math.random().toString(36).slice(2, 6), name: '新主机', type: 'ssh', group: '内网', address: '', port: 22, username: 'root', authType: 'key', keyPath: '', trackedDirs: [], _isNew: true })
  editIdx.value = cfg.hosts.length - 1 // 创建后立即打开编辑弹窗
}
function delHost(i) { cfg.hosts.splice(i, 1) }
/* 主机顺序 = 主页主机卡顺序，随 hosts 数组一起 PUT 保存 */
function moveHost(i, delta) {
  const j = i + delta
  if (i < 0 || j < 0 || j >= cfg.hosts.length) return
  const [h] = cfg.hosts.splice(i, 1)
  cfg.hosts.splice(j, 0, h)
  if (editIdx.value === i) editIdx.value = j
  else if (editIdx.value === j) editIdx.value = i
}
function hostSummary(h) {
  const kind = h.type === 'local' ? '本机' : 'SSH 远程'
  const addr = h.type === 'ssh' ? `${h.address || '未配置地址'}:${h.port || 22}` : (h.address || '127.0.0.1')
  const n = (h.effectiveDirs || h.trackedDirs || []).length
  return `${kind} · ${h.group || '未分组'} · ${addr}${n ? ` · ${n} 个跟踪目录` : ''}`
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

/* 审计事件配色：失败红 / 成功绿 / 其他默认 */
function evCls(ev) {
  if (/fail|denied/.test(ev)) return 'bad'
  if (/_ok|provision_ok/.test(ev)) return 'good'
  return ''
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="settings-overlay" @click.self="emit('close')">
      <div class="settings-panel mon">
        <header class="settings-head">
          <h2>监控设置</h2>
          <div class="head-actions">
            <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
          </div>
        </header>

        <div class="settings-body">
          <!-- 纳管主机：紧凑列表，点击弹嵌套编辑弹窗 -->
          <section>
            <h3>
              纳管主机 <span class="hcount">{{ cfg.hosts.length }}</span>
              <span class="grow" />
              <button class="mini-btn add-btn" @click="addHost">＋ 添加主机</button>
            </h3>
            <div class="host-list">
              <div v-for="(h, i) in cfg.hosts" :key="h.id" class="host-row" :class="{ open: editIdx === i }" @click="editIdx = i">
                <span class="hr-ico" :class="{ local: h.type === 'local' }">{{ h.type === 'local' ? '🖥' : '☁' }}</span>
                <span class="hr-main">
                  <span class="hr-name">{{ h.name || h.id }} <small class="mono">{{ h.id }}</small></span>
                  <span class="hr-sum">{{ hostSummary(h) }}</span>
                </span>
                <span v-if="h.type === 'local'" class="tag" title="本机主机不可删除">内置</span>
                <span class="hr-move" @click.stop>
                  <button class="mv-btn" :disabled="i === 0" title="上移（保存后生效）" @click.stop="moveHost(i, -1)">↑</button>
                  <button class="mv-btn" :disabled="i === cfg.hosts.length - 1" title="下移（保存后生效）" @click.stop="moveHost(i, 1)">↓</button>
                </span>
                <span class="hr-arrow">›</span>
              </div>
              <p v-if="!cfg.hosts.length" class="list-hint">暂无主机，点击「＋ 添加主机」创建。</p>
            </div>
            <p class="list-hint">用 ↑ / ↓ 调整主页主机卡顺序（保存后生效）；点击主机条目编辑连接信息与跟踪目录，修改为草稿，由底部「保存配置」统一提交。</p>
          </section>

          <!-- 全局自定义目录：仅非空时显示 -->
          <section v-if="cfg.trackedDirs.length">
            <h3>全局自定义目录 <span class="hcount">{{ cfg.trackedDirs.length }}</span></h3>
            <p class="list-hint" style="margin:0 0 8px">通常无需在此添加：本机的主页登记应用目录会自动并入，远程主机请在主机编辑弹窗里添加该机目录。</p>
            <div v-for="(d, i) in cfg.trackedDirs" :key="d.path" class="dir-row">
              <span class="d-path" :title="d.path">{{ d.path }}</span>
              <span class="tag">自定义</span>
              <button class="mini-btn danger" @click="delDir(i)">移除</button>
            </div>
            <button class="mini-btn add-btn" style="margin-top:8px" @click="addDir">＋ 添加目录</button>
          </section>

          <!-- 告警阈值 -->
          <section>
            <h3>告警阈值 <span class="hcount">持续超过设定分钟才触发告警</span></h3>
            <div class="grid3">
              <label class="fitem"><span>CPU %</span><input v-model.number="cfg.thresholds.cpuPct" type="number" step="0.1" /></label>
              <label class="fitem"><span>内存 %</span><input v-model.number="cfg.thresholds.memPct" type="number" step="0.1" /></label>
              <label class="fitem"><span>磁盘 %</span><input v-model.number="cfg.thresholds.diskPct" type="number" step="0.1" /></label>
              <label class="fitem"><span>每核负载</span><input v-model.number="cfg.thresholds.loadPerCore" type="number" step="0.1" /></label>
              <label class="fitem"><span>持续分钟</span><input v-model.number="cfg.thresholds.sustainMin" type="number" step="0.5" /></label>
            </div>
          </section>

          <!-- 采集与历史 -->
          <section>
            <h3>采集与历史</h3>
            <div class="grid4">
              <label class="fitem"><span>本机采集间隔(秒)</span><input v-model.number="cfg.collect.localIntervalSec" type="number" /></label>
              <label class="fitem"><span>远程采集间隔(秒)</span><input v-model.number="cfg.collect.remoteIntervalSec" type="number" /></label>
              <label class="fitem"><span>历史保留(天)</span><input v-model.number="cfg.collect.retentionDays" type="number" /></label>
              <label class="fitem"><span>容器映射刷新(秒)</span><input v-model.number="cfg.collect.dockerRefreshSec" type="number" /></label>
            </div>
          </section>

          <!-- 终端与通知 -->
          <section>
            <h3>终端与通知</h3>
            <div class="grid4">
              <label class="fitem"><span>终端空闲超时(分)</span><input v-model.number="cfg.terminal.idleTimeoutMin" type="number" /></label>
              <label class="fitem"><span>单会话上限(分)</span><input v-model.number="cfg.terminal.maxSessionMin" type="number" /></label>
              <label class="fitem"><span>每主机并发会话</span><input v-model.number="cfg.terminal.maxSessionsPerHost" type="number" /></label>
              <label class="fitem"><span>命令行审计</span>
                <span class="chk"><input v-model="cfg.terminal.recordCommands" type="checkbox" /> 记录回车提交的命令</span>
              </label>
              <label class="fitem span4"><span>告警 Webhook（POST JSON，留空关闭）</span><input v-model="cfg.webhookUrl" type="text" placeholder="https://..." /></label>
            </div>
          </section>

          <!-- 修改访问密码 -->
          <section>
            <h3>修改访问密码</h3>
            <div class="grid3">
              <label class="fitem"><span>旧密码</span><input v-model="oldPw" type="password" autocomplete="current-password" /></label>
              <label class="fitem"><span>新密码</span><input v-model="newPw" type="password" autocomplete="new-password" /></label>
              <label class="fitem"><span>&nbsp;</span><button class="primary-btn" @click="changePw">修改密码</button></label>
            </div>
          </section>

          <!-- 最近审计 -->
          <section>
            <h3>最近审计记录 <span class="hcount">会话 / 鉴权 / 配置变更</span></h3>
            <div class="audit-scroll">
              <table class="audit-table">
                <thead><tr><th>时间</th><th>事件</th><th>主机</th><th>IP</th><th>时长</th><th>备注</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in auditRows" :key="i">
                    <td class="num">{{ fmtTime(r.ts) }}</td>
                    <td><span class="ev" :class="evCls(r.event)">{{ r.event }}</span></td>
                    <td>{{ r.host || '-' }}</td>
                    <td class="num">{{ r.ip || '-' }}</td>
                    <td class="num">{{ r.durationSec != null ? r.durationSec + 's' : '-' }}</td>
                    <td class="note" :title="(r.commands || []).join(' ; ')">{{ r.reason || (r.keys && r.keys.join(',')) || (r.commands && r.commands.slice(-3).join(' ; ')) || '' }}</td>
                  </tr>
                  <tr v-if="!auditRows.length"><td colspan="6" class="empty">暂无记录</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <footer class="settings-foot">
          <span v-if="tip" class="save-tip" :class="tipCls">{{ tip }}</span>
          <span v-else class="hint">改动为草稿，保存后 ≤2 秒热加载生效，无需重启服务</span>
          <div class="foot-actions">
            <button class="mini-btn" @click="emit('close')">取消</button>
            <button class="primary-btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button>
          </div>
        </footer>
      </div>
    </div>

    <!-- 嵌套主机编辑弹窗（z-index 高于面板，草稿模式：修改留在 cfg，底部「保存配置」统一提交） -->
    <MonitorHostEdit
      :open="editIdx >= 0"
      :host="editIdx >= 0 ? cfg.hosts[editIdx] : { type: 'ssh' }"
      :is-new="!!(editIdx >= 0 && cfg.hosts[editIdx]?._isNew)"
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
/* ===== 模态框体系：与应用中心 SettingsPanel 完全同款 ===== */
.grow { flex: 1; }
.mono { font-family: var(--mono); font-size: 11.5px; color: var(--text-2); font-weight: 400; }
.settings-overlay {
  position: fixed; inset: 0; z-index: 70;
  background: rgb(0 0 0 / 0.45); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.settings-panel {
  background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
  width: min(820px, 100%); max-height: 90vh;
  display: flex; flex-direction: column; box-shadow: var(--shadow-hover);
}
.settings-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 14px 20px; border-bottom: 1px solid var(--border);
}
.settings-head h2 { margin: 0; font-size: 16px; }
.head-actions { display: flex; align-items: center; gap: 8px; }
.settings-body { overflow-y: auto; padding: 6px 20px 16px; }
.settings-foot {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 20px; border-top: 1px solid var(--border); font-size: 13px;
}
.settings-foot .hint { color: var(--text-2); font-size: 12.5px; }
.save-tip { font-size: 13px; }
.save-tip.ok { color: var(--green); }
.save-tip.bad { color: var(--red); }
.foot-actions { margin-left: auto; display: flex; gap: 8px; }

/* ===== 区块标题（无虚线，与应用中心 h3 一致） ===== */
section { margin-top: 18px; }
section h3 {
  margin: 0 0 10px; font-size: 13.5px; color: var(--text-2);
  display: flex; align-items: center; gap: 10px;
}
.hcount { font-size: 12px; color: var(--text-2); font-weight: 400; }

/* ===== 网格与表单字段（对齐应用中心 .fld） ===== */
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.fitem { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); min-width: 0; }
.fitem span { font-size: 12px; color: var(--text-2); }
.fitem input {
  font: inherit; font-size: 13.5px; color: var(--text);
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 10px; outline: none; width: 100%;
}
.fitem input:focus { border-color: var(--accent); }
.fitem.span4 { grid-column: span 4; }
.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); cursor: pointer; padding: 8px 0; white-space: nowrap; }
.chk input { accent-color: var(--accent); width: 14px; height: 14px; margin: 0; flex: none; }

/* ===== 按钮体系（对齐应用中心） ===== */
.mini-btn {
  border: 1px solid var(--border); background: var(--bg); color: var(--text-2);
  border-radius: 8px; padding: 6px 14px; font: inherit; font-size: 12.5px;
  cursor: pointer; white-space: nowrap;
}
.mini-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.mini-btn:disabled { opacity: 0.5; cursor: default; }
.mini-btn.danger:hover { color: var(--red); border-color: var(--red); }
.mini-btn.add-btn { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.primary-btn {
  border: 1px solid var(--accent); background: var(--accent); color: #fff;
  border-radius: 8px; padding: 7px 18px; font: inherit; font-size: 13.5px; cursor: pointer;
  width: 100%;
}
.primary-btn:hover:not(:disabled) { filter: brightness(1.06); }
.primary-btn:disabled { opacity: 0.6; cursor: default; }

/* ===== 纳管主机紧凑列表（对齐应用中心 .app-row） ===== */
.host-list { display: flex; flex-direction: column; gap: 8px; }
.host-row {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 12px; background: var(--bg-soft);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.host-row:hover { border-color: var(--accent); background: var(--accent-soft); }
.host-row.open { border-color: var(--accent); }
.hr-ico {
  width: 30px; height: 30px; flex: none; display: flex; align-items: center; justify-content: center;
  border-radius: 8px; font-size: 15px; background: var(--amber-soft); color: var(--amber);
}
.hr-ico.local { background: var(--accent-soft); color: var(--accent); }
.hr-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.hr-name { font-size: 13.5px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }
.hr-name small { color: var(--text-2); font-weight: 400; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hr-sum { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hr-move { display: inline-flex; gap: 3px; flex: none; }
.mv-btn {
  width: 22px; height: 22px; padding: 0;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text-2);
  font-size: 12px; line-height: 1; cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.mv-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.mv-btn:disabled { opacity: 0.35; cursor: default; }
.hr-arrow { flex: none; color: var(--text-2); font-size: 16px; }

/* ===== 全局自定义目录行 ===== */
.dir-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px;
  margin-bottom: 6px; background: var(--bg-soft);
}
.d-path { font-family: var(--mono); font-size: 12.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ===== 审计表 ===== */
.audit-scroll { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.audit-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.audit-table th, .audit-table td { border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left; white-space: nowrap; }
.audit-table th { color: var(--text-2); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--bg); z-index: 1; }
.audit-table tbody tr { transition: background 0.12s ease; }
.audit-table tbody tr:hover { background: var(--bg-hover); }
.audit-table td.num { font-family: var(--mono); font-size: 12px; }
.audit-table td.note { max-width: 320px; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); }
.ev { font-family: var(--mono); font-size: 11.5px; }
.ev.bad { color: var(--red); }
.ev.good { color: var(--green); }
.empty { color: var(--text-2); text-align: center; padding: 16px; }

/* ===== 响应式 ===== */
@media (max-width: 720px) {
  .grid3 { grid-template-columns: 1fr; }
  .grid4 { grid-template-columns: repeat(2, 1fr); }
  .fitem.span4 { grid-column: span 2; }
  .settings-overlay { padding: 8px; }
  .settings-foot .hint { display: none; }
}
</style>
