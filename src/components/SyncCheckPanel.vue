<script setup>
import { ref, watch } from 'vue'
import { monApi } from '../lib/monitor-api.js'

/* 应用中心 ⇄ 监控中心 同步检查面板：
   只读实时计算（GET /api/monitor/sync-check）展示三类状态——
   已同步配对（含待对齐的字段差异）/ 同步异常（勾选了但找不到对端）/ 可同步候选（同地址未勾选）。
   支持强制重同步（POST sync-run）与一键配对（应用为主 = 勾 monitorSync；主机为主 = 勾 appSync）。 */
const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const loading = ref(false)
const busyId = ref('') // 正在执行一键配对的候选行
const resyncing = ref(false)
const err = ref('')
const data = ref(null)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function load() {
  loading.value = true
  err.value = ''
  try {
    data.value = await monApi('/api/monitor/sync-check')
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

async function resync() {
  resyncing.value = true
  err.value = ''
  try {
    await monApi('/api/monitor/sync-run', { method: 'POST' })
    await sleep(1500) // 等 watcher 防抖（600ms）+ 双向同步跑完
    await load()
  } catch (e) {
    err.value = e.message
  } finally {
    resyncing.value = false
  }
}

/* 应用为主：给应用勾 monitorSync（方向一回写主机共享字段） */
async function pairAsApp(c) {
  busyId.value = c.appId + '|' + c.hostId
  err.value = ''
  try {
    const r = await fetch('/api/config', { cache: 'no-store' })
    if (!r.ok) throw new Error(`读取应用配置失败 HTTP ${r.status}`)
    const cfg = await r.json()
    const a = (cfg.remoteApps || []).find((x) => x && x.id === c.appId)
    if (!a) throw new Error(`应用 ${c.appId} 不存在`)
    a.monitorSync = true
    const w = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ apps: cfg.apps || [], remoteApps: cfg.remoteApps || [], page: cfg.page || {} }),
    })
    if (!w.ok) throw new Error((await w.json().catch(() => ({}))).error || `保存失败 HTTP ${w.status}`)
    await sleep(1500)
    await load()
  } catch (e) {
    err.value = '配对失败：' + e.message
  } finally {
    busyId.value = ''
  }
}

/* 主机为主：给主机勾 appSync（方向二回写应用共享字段） */
async function pairAsHost(c) {
  busyId.value = c.appId + '|' + c.hostId
  err.value = ''
  try {
    const cfg = await monApi('/api/monitor/config')
    const h = (cfg.hosts || []).find((x) => x && x.id === c.hostId)
    if (!h) throw new Error(`主机 ${c.hostId} 不存在`)
    h.appSync = true
    await monApi('/api/monitor/config', { method: 'PUT', body: { hosts: cfg.hosts } })
    await sleep(1500)
    await load()
  } catch (e) {
    err.value = '配对失败：' + e.message
  } finally {
    busyId.value = ''
  }
}

watch(
  () => props.open,
  (v) => v && load(),
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sc-overlay" @click.self="emit('close')">
      <div class="sc-panel" role="dialog" aria-label="同步检查">
        <header class="sc-head">
          <h2>同步检查 <small>应用中心 ⇄ 监控中心</small></h2>
          <span class="grow" />
          <button class="mini-btn" :disabled="resyncing" @click="resync">{{ resyncing ? '重同步中…' : '强制重同步' }}</button>
          <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
        </header>

        <div class="sc-body">
          <p class="sc-tip">
            按「同 id 优先、其次同地址」检查两侧配对；勾选方为信息事实源（应用勾「同步到监控中心」→ 主机跟随应用；主机勾「同步到应用中心」→ 应用跟随主机）。
            同步由配置变更自动触发，改动信息后点「强制重同步」可立即对齐。
          </p>
          <div v-if="loading && !data" class="sc-empty">检查中…</div>
          <p v-else-if="err" class="sc-err">{{ err }}</p>

          <template v-if="data">
            <!-- 已同步配对 -->
            <section>
              <h3>已同步配对 <span class="count">{{ data.pairs.length }}</span></h3>
              <p v-if="!data.pairs.length" class="sc-empty">暂无配对 —— 下方候选可一键建立。</p>
              <div v-for="p in data.pairs" :key="p.appId + '|' + p.hostId" class="sc-row ok">
                <span class="sc-main">
                  <b>{{ p.appName }}</b><code>{{ p.appId }}</code>
                  <span class="arrow">⇄</span>
                  <b>{{ p.hostName }}</b><code>{{ p.hostId }}</code>
                </span>
                <span class="sc-meta">
                  按{{ p.via === 'id' ? '同 id' : '同地址' }}配对 · {{ p.truth === 'app' ? '应用为主' : '主机为主' }}
                </span>
                <div v-if="p.diffs.length" class="sc-diffs">
                  <span v-for="d in p.diffs" :key="d.field" class="sc-diff" :title="`重同步后：${d.from || '（空）'} → ${d.to}`">
                    {{ d.field }}「{{ d.from || '空' }}」→「{{ d.to }}」
                  </span>
                </div>
              </div>
            </section>

            <!-- 同步异常 -->
            <section v-if="data.unpairedApps.length || data.unpairedHosts.length">
              <h3>同步异常 <span class="count warn">{{ data.unpairedApps.length + data.unpairedHosts.length }}</span></h3>
              <div v-for="u in data.unpairedApps" :key="'a-' + u.appId" class="sc-row warn">
                <span class="sc-main"><b>{{ u.appName }}</b><code>{{ u.appId }}</code> <span class="arrow">⇄</span> 监控中心</span>
                <span class="sc-meta">{{ u.reason }}</span>
              </div>
              <div v-for="u in data.unpairedHosts" :key="'h-' + u.hostId" class="sc-row warn">
                <span class="sc-main">应用中心 <span class="arrow">⇄</span> <b>{{ u.hostName }}</b><code>{{ u.hostId }}</code></span>
                <span class="sc-meta">{{ u.reason }}</span>
              </div>
            </section>

            <!-- 可同步候选 -->
            <section>
              <h3>可同步候选 <span class="count">{{ data.candidates.length }}</span></h3>
              <p v-if="!data.candidates.length" class="sc-empty">没有可配对的同地址应用/主机组合。</p>
              <div v-for="c in data.candidates" :key="c.appId + '|' + c.hostId" class="sc-row cand">
                <span class="sc-main">
                  <b>{{ c.appName }}</b><code>{{ c.appId }}</code>
                  <span class="arrow">⇄</span>
                  <b>{{ c.hostName }}</b><code>{{ c.hostId }}</code>
                  <span class="sc-addr">{{ c.address }}</span>
                </span>
                <span class="sc-actions">
                  <button class="mini-btn" :disabled="busyId === c.appId + '|' + c.hostId" title="勾选应用的「同步到监控中心」：主机名/分组跟随应用" @click="pairAsApp(c)">
                    {{ busyId === c.appId + '|' + c.hostId ? '配对中…' : '应用为主' }}
                  </button>
                  <button class="mini-btn" :disabled="busyId === c.appId + '|' + c.hostId" title="勾选主机的「同步到应用中心」：应用名/位置跟随主机" @click="pairAsHost(c)">
                    主机为主
                  </button>
                </span>
              </div>
            </section>

            <p v-if="!data.pairs.length && !data.unpairedApps.length && !data.unpairedHosts.length && !data.candidates.length" class="sc-empty big">
              ✓ 两侧没有需要同步的条目
            </p>
          </template>
        </div>

        <footer class="sc-foot">
          <span>检查结果实时计算自两份配置；配对后信息随配置变更自动跟随。</span>
          <span class="grow" />
          <button class="mini-btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script>
export default { name: 'SyncCheckPanel' }
</script>

<style scoped>
.grow { flex: 1; }
.sc-overlay {
  position: fixed; inset: 0; z-index: 66;
  background: rgb(0 0 0 / 0.45); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.sc-panel {
  background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
  width: min(760px, 100%); max-height: 90vh; display: flex; flex-direction: column;
  box-shadow: var(--shadow-hover);
}
.sc-head { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
.sc-head h2 { margin: 0; font-size: 16px; display: flex; align-items: baseline; gap: 8px; }
.sc-head small { font-size: 12px; color: var(--text-2); font-weight: 400; }
.sc-body { overflow-y: auto; padding: 12px 20px 18px; }
.sc-tip { margin: 0 0 12px; font-size: 12px; color: var(--text-2); line-height: 1.6; }
.sc-err { color: var(--red); font-size: 13px; }
.sc-empty { color: var(--text-2); font-size: 12.5px; background: var(--bg-hover); border-radius: 8px; padding: 10px 12px; }
.sc-empty.big { text-align: center; padding: 24px; color: var(--green); font-size: 13.5px; }
section { margin-bottom: 16px; }
section h3 { margin: 0 0 8px; font-size: 13px; color: var(--text-2); display: flex; align-items: center; gap: 6px; }
.count { font-size: 11px; background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 0 7px; }
.count.warn { background: var(--amber-soft); color: var(--amber); }
.sc-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-bottom: 6px;
  background: var(--bg-soft);
}
.sc-row.ok { border-left: 3px solid var(--green); }
.sc-row.warn { border-left: 3px solid var(--amber); }
.sc-row.cand { border-left: 3px solid var(--border-strong); }
.sc-main { display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; font-size: 13px; }
.sc-main code { font-family: var(--mono); font-size: 11px; color: var(--text-2); background: var(--bg-hover); border-radius: 4px; padding: 0 4px; }
.sc-addr { font-family: var(--mono); font-size: 11px; color: var(--text-2); }
.arrow { color: var(--text-2); }
.sc-meta { margin-left: auto; font-size: 11.5px; color: var(--text-2); }
.sc-actions { margin-left: auto; display: inline-flex; gap: 6px; }
.sc-diffs { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px; }
.sc-diff {
  font-size: 11px; border-radius: 999px; padding: 1px 8px;
  background: var(--amber-soft); color: var(--amber);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mini-btn {
  border: 1px solid var(--border); background: var(--bg); color: var(--text-2);
  border-radius: 8px; padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.mini-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.mini-btn:disabled { opacity: 0.5; cursor: default; }
.icon-btn {
  border: 0; background: none; cursor: pointer; color: var(--text-2);
  width: 28px; height: 28px; border-radius: 7px; font-size: 13px;
  display: inline-flex; align-items: center; justify-content: center;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.sc-foot { display: flex; align-items: center; gap: 10px; padding: 10px 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-2); }
@media (max-width: 640px) { .sc-overlay { padding: 8px; } .sc-meta { margin-left: 0; flex-basis: 100%; } }
</style>
