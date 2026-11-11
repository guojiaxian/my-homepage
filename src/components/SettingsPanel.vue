<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const saving = ref(false)
const savedOk = ref(false)
const error = ref('')
/* 表单 = 统一探测盘点（apps.json，清单唯一来源）+ 手工注解（/api/config）合并。
   面板不再增删条目：新应用由探测自动出现，「隐藏」决定是否在前端展示（后端照常探测与监控），
   保存时把每个盘点行的展示信息序列化回注解。 */
const form = ref({ apps: [], remoteApps: [], page: {} })
/* 盘点行快照（id -> 行）：端口提示 / 待补充 / 默认名等展示依据 */
const invById = ref(new Map())

const normDir = (p) => String(p || '').replace(/\/+$/, '')
const str = (v) => (typeof v === 'string' ? v.trim() : '')

const KIND_OPTIONS = [
  { value: 'web', label: 'Web' },
  { value: 'app', label: 'APP' },
  { value: 'miniapp', label: '小程序' },
  { value: 'tv', label: '电视' },
  { value: 'cli', label: 'CLI' },
]

function asList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  return []
}

function listText(value) {
  return asList(value).join(', ')
}

function setList(a, key, ev) {
  a[key] = ev.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}

function tagsText(a) {
  return (a.tags ?? []).join(', ')
}

function setTags(a, ev) {
  a.tags = ev.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}

function hasKind(a, value) {
  return (a.kinds ?? []).includes(value)
}

function toggleKind(a, value, checked) {
  const set = new Set(a.kinds ?? [])
  if (checked) set.add(value)
  else set.delete(value)
  a.kinds = KIND_OPTIONS.map((o) => o.value).filter((v) => set.has(v))
}

/** 注解匹配：本机按目录；远程按目录（兼容旧 gitDir） */
function findMeta(cfg, inv) {
  const dir = normDir(inv.directory)
  if (!inv.remote) {
    return (cfg.apps ?? []).find((a) => a && normDir(a.directory) === dir) ?? null
  }
  const host = str(inv.host)
  return (
    (cfg.remoteApps ?? []).find(
      (a) => a && (normDir(a.directory) === dir || normDir(a.gitDir) === dir) && (!str(a.host) || !host || str(a.host) === host),
    ) ?? null
  )
}

/** 盘点行 + 注解 → 可编辑表单行（注解只提供展示信息；清单字段来自盘点，只读） */
function buildRow(inv, meta) {
  const isRemote = Boolean(inv.remote)
  return {
    _invId: inv.id,
    _invDir: inv.directory || '',
    _isRemote: isRemote,
    _host: str(inv.host),
    _invPort: Number.isInteger(inv.port) ? inv.port : null,
    _invExternal: Boolean(inv.external),
    _pending: Boolean(inv.pending),
    _remote: isRemote,
    id: inv.id,
    directory: inv.directory || '',
    host: str(inv.host),
    env: inv.env || (isRemote ? 'public' : 'lan'),
    name: str(meta?.name),
    description: str(meta?.description),
    icon: str(meta?.icon),
    github: str(meta?.github),
    tags: asList(meta?.tags),
    kinds: (Array.isArray(meta?.kinds) && meta.kinds.length ? meta.kinds : ['web']).filter((k) =>
      KIND_OPTIONS.some((o) => o.value === k),
    ),
    https: Boolean(meta?.https),
    hidden: Boolean(meta?.hidden || meta?.exclude),
    url: str(meta?.url),
    location: str(meta?.location),
    expectedPort: meta?.expectedPort ?? null,
    languages: asList(meta?.languages),
    frontend: asList(meta?.frontend),
    backend: asList(meta?.backend),
  }
}

/** 当前探测到的实际端口（来自盘点） */
function detectedPort(a) {
  const inv = invById.value.get(a.id)
  return inv && Number.isInteger(inv.port) ? inv.port : null
}

/** 实际端口与期望端口不一致时，提供「采用」按钮 */
function canAdoptPort(a) {
  const port = detectedPort(a)
  return port != null && Number(a.expectedPort) !== port
}

function adoptPort(a) {
  const port = detectedPort(a)
  if (port != null) a.expectedPort = port
}

/** 展示名：注解名优先，缺省用盘点名（目录名） */
function displayName(a) {
  return a.name || invById.value.get(a.id)?.name || a.id || '未命名应用'
}

/** 列表行的摘要文案：应用形式 · 归属 · 端口/目录 */
function kindLabels(a) {
  return (a.kinds ?? []).map((k) => KIND_OPTIONS.find((o) => o.value === k)?.label).filter(Boolean)
}

function rowMeta(a) {
  const parts = [...kindLabels(a)]
  if (a._isRemote) {
    parts.push(a.env === 'public' ? '公网' : '外机')
    if (a._host) parts.push(a._host)
    if (a.directory) parts.push(a.directory)
  } else {
    parts.push('本机')
    const p = Number(a.expectedPort)
    if (a.expectedPort != null && a.expectedPort !== '' && !Number.isNaN(p)) parts.push(`:${p}`)
    else if (detectedPort(a) != null) parts.push(`:${detectedPort(a)}`)
  }
  return parts.join(' · ')
}

/** 远程应用按归属拆分：外机（局域网其他主机）/ 公网（云服务器） */
const externalRows = computed(() => form.value.remoteApps.filter((a) => a.env !== 'public'))
const publicRows = computed(() => form.value.remoteApps.filter((a) => a.env === 'public'))

/** 当前正在编辑的条目：null 或 { list: 'apps' | 'remoteApps', index } */
const editing = ref(null)
const editingApp = computed(() => {
  if (!editing.value) return null
  return form.value[editing.value.list]?.[editing.value.index] ?? null
})
const editingIsRemote = computed(() => editing.value?.list === 'remoteApps')

function openEditor(list, index) {
  editing.value = { list, index }
}

function closeEditor() {
  editing.value = null
}

/** 恢复默认信息：清空本行的注解类展示字段（清单字段只读，不受影响） */
function resetEditing() {
  const a = editingApp.value
  if (!a) return
  a.name = ''
  a.description = ''
  a.icon = ''
  a.github = ''
  a.tags = []
  a.languages = []
  a.frontend = []
  a.backend = []
  a.https = false
  a.hidden = false
  a.url = ''
  a.location = ''
}

async function load() {
  loading.value = true
  error.value = ''
  savedOk.value = false
  editing.value = null
  try {
    const [cfgRes, invRes] = await Promise.allSettled([
      fetch('/api/config', { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }),
      fetch(`./apps.json?t=${Date.now()}`, { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }),
    ])
    const cfg = cfgRes.status === 'fulfilled' ? cfgRes.value : null
    if (!cfg) throw new Error(cfgRes.reason?.message || '加载配置失败')
    const invApps = invRes.status === 'fulfilled' ? (invRes.value.apps ?? []) : []
    const invPage = invRes.status === 'fulfilled' ? (invRes.value.page ?? {}) : {}

    const invByIdMap = new Map(invApps.map((a) => [a.id, a]))
    invById.value = invByIdMap

    if (invApps.length) {
      // 盘点驱动：本机应用 = 非远程行；远程行按主机分组归属（外机 / 公网）
      form.value = {
        apps: invApps.filter((a) => !a.remote).map((a) => buildRow(a, findMeta(cfg, a))),
        remoteApps: invApps.filter((a) => a.remote).map((a) => buildRow(a, findMeta(cfg, a))),
        page: { siteName: '', heroTitle: '', heroSubtitle: '', ...(cfg.page ?? {}), ...(invPage ?? {}) },
      }
    } else {
      // apps.json 不可用时退回注解列表（保证设置面板仍可打开）
      form.value = {
        apps: (cfg.apps ?? []).map((a) =>
          buildRow({ id: a.id, directory: a.directory, remote: false, env: 'lan', port: null, pending: false }, a),
        ),
        remoteApps: (cfg.remoteApps ?? []).map((a) =>
          buildRow({ id: a.id, directory: a.directory ?? a.gitDir ?? '', remote: true, env: a.env, host: a.host, port: null, pending: false }, a),
        ),
        page: { siteName: '', heroTitle: '', heroSubtitle: '', ...(cfg.page ?? {}) },
      }
    }
  } catch (err) {
    error.value = `加载配置失败：${err.message}（请确认设置服务已运行：systemctl status my-homepage-settings）`
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (o) => o && load(),
)

async function save() {
  saving.value = true
  error.value = ''
  savedOk.value = false
  try {
    // 序列化回注解：只携带展示信息字段（清单字段由探测生成，服务端白名单会忽略未知字段）
    const payload = {
      apps: form.value.apps.map((a) => ({
        id: a.id,
        directory: a.directory,
        expectedPort: a.expectedPort ?? null,
        kinds: a.kinds,
        env: 'lan',
        ...(a.https ? { https: true } : {}),
        ...(a.hidden ? { hidden: true } : {}),
        ...(str(a.name) ? { name: str(a.name) } : {}),
        ...(str(a.description) ? { description: str(a.description) } : {}),
        ...(str(a.icon) ? { icon: str(a.icon) } : {}),
        ...(str(a.github) ? { github: str(a.github) } : {}),
        ...(a.tags.length ? { tags: a.tags } : {}),
        ...(a.languages.length ? { languages: a.languages } : {}),
        ...(a.frontend.length ? { frontend: a.frontend } : {}),
        ...(a.backend.length ? { backend: a.backend } : {}),
      })),
      remoteApps: form.value.remoteApps.map((a) => ({
        id: a.id,
        host: a._host,
        ...(a.directory ? { directory: a.directory } : {}),
        kinds: a.kinds,
        env: a.env,
        ...(a.hidden ? { hidden: true } : {}),
        ...(str(a.url) ? { url: str(a.url) } : {}),
        ...(str(a.location) ? { location: str(a.location) } : {}),
        ...(str(a.name) ? { name: str(a.name) } : {}),
        ...(str(a.description) ? { description: str(a.description) } : {}),
        ...(str(a.icon) ? { icon: str(a.icon) } : {}),
        ...(str(a.github) ? { github: str(a.github) } : {}),
        ...(a.tags.length ? { tags: a.tags } : {}),
        ...(a.languages.length ? { languages: a.languages } : {}),
        ...(a.frontend.length ? { frontend: a.frontend } : {}),
        ...(a.backend.length ? { backend: a.backend } : {}),
      })),
      page: form.value.page,
    }
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)

    // 配置已写入，统一探测在后台执行：立即反馈并关闭，
    // 父组件轮询 apps.json 的 probedAt，变化后自动刷新页面。
    // savedAt 用服务端时钟：与 apps.json 的 probedAt（服务端 ISO）比较不受浏览器时钟偏差影响
    const savedAt = Number.isFinite(data.serverTime) ? data.serverTime : Date.now()
    saving.value = false
    savedOk.value = true
    emit('saved', savedAt)
    setTimeout(() => {
      savedOk.value = false
      emit('close')
    }, 700)
  } catch (err) {
    saving.value = false
    error.value = `保存失败：${err.message}`
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="settings-overlay" @click.self="emit('close')">
      <div class="settings-panel" role="dialog" aria-label="设置">
        <header class="settings-head">
          <h2>设置</h2>
          <div class="head-actions">
            <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
          </div>
        </header>

        <div v-if="loading" class="settings-tip">加载中…</div>
        <div v-else-if="error && !form.apps.length" class="settings-tip">{{ error }}</div>

        <div v-else class="settings-body">
          <p class="list-hint" style="margin: 14px 0 0">
            应用清单由统一探测自动发现（每台服务器的探测目录在「监控中心 → 设置 → 对应主机」中配置），
            新应用会同时出现在应用中心与监控中心；此处维护展示信息，勾选「在前端隐藏」可隐藏展示（后端照常探测与监控）。
          </p>

          <!-- 页面信息 -->
          <section>
            <h3>页面信息</h3>
            <div class="grid3">
              <label class="fld"><span>站点名称（顶栏 / 浏览器标题）</span><input v-model="form.page.siteName" /></label>
              <label class="fld"><span>首页主标题</span><input v-model="form.page.heroTitle" /></label>
              <label class="fld"><span>首页副标题</span><input v-model="form.page.heroSubtitle" /></label>
            </div>
          </section>

          <!-- 本机应用：清单来自统一探测，点击弹窗编辑展示信息 -->
          <section>
            <h3>
              本机应用（{{ form.apps.length }}）
              <span class="hcount">探测目录自动发现</span>
            </h3>
            <div class="app-list">
              <button
                v-for="(a, i) in form.apps"
                :key="a.id"
                type="button"
                class="app-row"
                @click="openEditor('apps', i)"
              >
                <span class="app-row-icon">{{ a.icon || '📦' }}</span>
                <span class="app-row-main">
                  <span class="app-row-name">
                    {{ displayName(a) }}
                    <small class="mono">{{ a.id }}</small>
                  </span>
                  <span class="app-row-meta">{{ rowMeta(a) }}</span>
                </span>
                <span v-if="a._pending" class="tag">待补充</span>
                <span v-if="a.hidden" class="tag warn" title="已勾选「在前端隐藏」，后端仍照常探测与监控">已隐藏</span>
                <span class="app-row-arrow">›</span>
              </button>
            </div>
            <p class="list-hint">点击应用条目编辑展示信息</p>
          </section>

          <!-- 外机应用：局域网内其他主机（盘点自动发现） -->
          <section>
            <h3>
              外机应用（{{ externalRows.length }})
              <span class="hcount">各主机探测目录自动发现</span>
            </h3>
            <div class="app-list">
              <button
                v-for="(a, i) in externalRows"
                :key="a.id"
                type="button"
                class="app-row"
                @click="openEditor('remoteApps', form.remoteApps.indexOf(a))"
              >
                <span class="app-row-icon">{{ a.icon || '🖥️' }}</span>
                <span class="app-row-main">
                  <span class="app-row-name">
                    {{ displayName(a) }}
                    <small class="mono">{{ a.id }}</small>
                  </span>
                  <span class="app-row-meta">{{ rowMeta(a) }}</span>
                </span>
                <span v-if="a._pending" class="tag">待补充</span>
                <span v-if="a.hidden" class="tag warn" title="已勾选「在前端隐藏」，后端仍照常探测与监控">已隐藏</span>
                <span class="app-row-arrow">›</span>
              </button>
            </div>
            <p class="list-hint">部署在局域网内其他服务器上的应用，由对应主机的探测目录自动发现</p>
          </section>

          <!-- 公网应用：云服务器等公网主机（盘点自动发现） -->
          <section>
            <h3>
              公网应用（{{ publicRows.length }}）
              <span class="hcount">各主机探测目录自动发现</span>
            </h3>
            <div class="app-list">
              <button
                v-for="(a, i) in publicRows"
                :key="a.id"
                type="button"
                class="app-row"
                @click="openEditor('remoteApps', form.remoteApps.indexOf(a))"
              >
                <span class="app-row-icon">{{ a.icon || '☁️' }}</span>
                <span class="app-row-main">
                  <span class="app-row-name">
                    {{ displayName(a) }}
                    <small class="mono">{{ a.id }}</small>
                  </span>
                  <span class="app-row-meta">{{ rowMeta(a) }}</span>
                </span>
                <span v-if="a._pending" class="tag">待补充</span>
                <span v-if="a.hidden" class="tag warn" title="已勾选「在前端隐藏」，后端仍照常探测与监控">已隐藏</span>
                <span class="app-row-arrow">›</span>
              </button>
            </div>
            <p class="list-hint">部署在云服务器等公网主机上的应用，由对应主机的探测目录自动发现</p>
          </section>
        </div>

        <footer class="settings-foot">
          <span v-if="error" class="err">{{ error }}</span>
          <span v-else-if="savedOk" class="okmsg">✓ 已保存，探测更新中，几秒内自动刷新…</span>
          <span v-else class="hint">保存后自动重跑统一探测，几秒内页面生效</span>
          <div class="foot-actions">
            <button class="mini-btn" :disabled="saving" @click="emit('close')">取消</button>
            <button class="primary-btn" :disabled="saving || loading" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </footer>
      </div>
    </div>

    <!-- 单个应用的编辑弹窗（嵌套在设置面板之上）：清单字段只读，展示信息可编辑 -->
    <div v-if="open && editingApp" class="editor-overlay" @click.self="closeEditor">
      <div class="editor-panel" role="dialog" :aria-label="`编辑 ${displayName(editingApp)}`">
        <header class="settings-head">
          <h2 class="editor-title">
            <span class="app-edit-icon">{{ editingApp.icon || (editingIsRemote ? '☁️' : '📦') }}</span>
            {{ displayName(editingApp) }}
            <small class="mono">{{ editingApp.id }}</small>
          </h2>
          <button class="icon-btn" title="关闭" @click="closeEditor">✕</button>
        </header>

        <div class="settings-body editor-body">
          <p class="host-owned-note">
            应用清单由统一探测生成：id / 目录 / 归属主机为探测结果（只读）；下方信息为展示注解。
            <template v-if="editingApp._pending">该应用为新发现，尚未填写任何展示信息。</template>
          </p>
          <div class="grid3">
            <label class="fld">
              <span>id（探测生成，不可改）</span>
              <input :value="editingApp.id" readonly class="mono" />
            </label>
            <label class="fld"><span>图标 emoji</span><input v-model="editingApp.icon" :placeholder="editingApp._isRemote ? '☁️' : '📦'" /></label>
            <label v-if="!editingIsRemote" class="fld">
              <span>期望端口 <small v-if="detectedPort(editingApp)" class="port-hint">当前探测 :{{ detectedPort(editingApp) }}</small></span>
              <div class="port-row">
                <input v-model="editingApp.expectedPort" inputmode="numeric" placeholder="如 3000" />
                <button
                  v-if="canAdoptPort(editingApp)"
                  type="button"
                  class="use-port"
                  title="把实际探测端口写入期望端口"
                  @click="adoptPort(editingApp)"
                >
                  采用
                </button>
              </div>
            </label>
            <label v-else class="fld"><span>位置（列表「服务器 / 目录」列展示）</span><input v-model="editingApp.location" placeholder="如 阿里云" /></label>
          </div>
          <div class="grid2">
            <label class="fld">
              <span>名称</span>
              <input v-model="editingApp.name" :placeholder="invById.get(editingApp.id)?.name || editingApp.id" />
            </label>
            <label class="fld"><span>标签（逗号分隔）</span><input :value="tagsText(editingApp)" @input="setTags(editingApp, $event)" /></label>
          </div>
          <label class="fld">
            <span>{{ editingIsRemote ? '归属主机 / 应用目录（探测发现，只读）' : '服务器目录（探测发现，只读）' }}</span>
            <input
              :value="editingIsRemote ? `${editingApp._host || ''}${editingApp.directory ? ' · ' + editingApp.directory : ''}` : editingApp.directory"
              readonly
              class="mono"
            />
          </label>
          <label class="fld"><span>GitHub 地址</span><input v-model="editingApp.github" placeholder="https://github.com/…" /></label>
          <div v-if="editingIsRemote" class="grid2">
            <label class="fld"><span>访问页面 URL（点击应用时的跳转地址）</span><input v-model="editingApp.url" class="mono" placeholder="http://…" /></label>
            <label class="fld"><span>&nbsp;</span><span class="foot-note">留空且无 Web 端口时不生成访问链接</span></label>
          </div>
          <div class="grid3">
            <label class="fld"><span>主要语言（逗号分隔，留空用自动识别）</span><input :value="listText(editingApp.languages)" placeholder="如 Python, JavaScript" @input="setList(editingApp, 'languages', $event)" /></label>
            <label class="fld"><span>前端框架（留空用自动识别）</span><input :value="listText(editingApp.frontend)" placeholder="如 Vue 3 + Vite" @input="setList(editingApp, 'frontend', $event)" /></label>
            <label class="fld"><span>后端框架（留空用自动识别）</span><input :value="listText(editingApp.backend)" placeholder="如 FastAPI" @input="setList(editingApp, 'backend', $event)" /></label>
          </div>
          <span class="stack-note">{{ editingIsRemote ? '远程应用不在本机，技术栈需手动填写。' : '技术栈留空时以探测自动识别为准。' }}</span>
          <label class="fld"><span>简介</span><textarea v-model="editingApp.description" rows="2" /></label>
          <div class="app-edit-foot">
            <span class="chk-group">
              <span class="foot-label">应用形式</span>
              <label v-for="k in KIND_OPTIONS" :key="k.value" class="chk">
                <input
                  type="checkbox"
                  :checked="hasKind(editingApp, k.value)"
                  @change="toggleKind(editingApp, k.value, $event.target.checked)"
                />
                {{ k.label }}
              </label>
              <span class="foot-note">未勾选 Web = 离线应用，不探测端口</span>
            </span>
            <div class="env-fld">
              <span>归属</span>
              <span class="foot-note">{{ editingIsRemote ? (editingApp.env === 'public' ? '公网（由主机分组决定）' : '外机（由主机分组决定）') : '本机（本服务器）' }}</span>
            </div>
          </div>
          <div class="app-edit-foot">
            <span class="chk-group">
              <label v-if="!editingIsRemote" class="chk" title="访问链接使用 https://（自签名证书会触发浏览器警告）">
                <input v-model="editingApp.https" type="checkbox" /> 使用 HTTPS
              </label>
              <label class="chk" title="隐藏后应用不再出现在应用中心 / 监控设置之外的前端列表中；后端探测与监控照常进行">
                <input v-model="editingApp.hidden" type="checkbox" /> 在前端隐藏（后端继续探测）
              </label>
            </span>
          </div>
        </div>

        <footer class="settings-foot">
          <button class="del-btn" @click="resetEditing">恢复默认信息</button>
          <span class="hint">修改先存于草稿，点设置面板底部「保存」后写入</span>
          <div class="foot-actions">
            <button class="mini-btn" @click="closeEditor">完成</button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgb(0 0 0 / 0.45);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgb(0 0 0 / 0.45);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.settings-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: min(880px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-hover);
}

.editor-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: min(760px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-hover);
}

.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-head h2 {
  margin: 0;
  font-size: 16px;
}

.editor-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.editor-title small {
  color: var(--text-2);
  font-weight: 400;
  font-size: 12.5px;
}

.app-edit-icon {
  font-size: 17px;
}

.settings-body {
  overflow-y: auto;
  padding: 6px 20px 16px;
}

.editor-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 14px;
}

.settings-tip {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-2);
}

section {
  margin-top: 18px;
}

section h3 {
  margin: 0 0 10px;
  font-size: 13.5px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 10px;
}

.hcount {
  font-size: 12px;
  color: var(--gray);
  font-weight: 400;
}

/* 应用列表（紧凑行，点击弹窗编辑） */
.app-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.app-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--text);
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.app-row:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.app-row-icon {
  flex: none;
  font-size: 16px;
}

.app-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.app-row-name {
  font-size: 13.5px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.app-row-name small {
  color: var(--text-2);
  font-weight: 400;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-row-meta {
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-row-arrow {
  flex: none;
  color: var(--text-2);
  font-size: 16px;
}

.list-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--gray);
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.grid3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}

.fld {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  min-width: 0;
}

.fld input,
.fld textarea {
  font: inherit;
  font-size: 13.5px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
  outline: none;
  width: 100%;
}

.fld input:focus,
.fld textarea:focus {
  border-color: var(--accent);
}

.fld input[readonly] {
  background: var(--bg-hover);
  color: var(--text-2);
}

.fld textarea {
  resize: vertical;
}

.port-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.port-row input {
  flex: 1;
  min-width: 0;
}

.port-hint {
  color: var(--text-2);
  font-size: 12px;
  font-family: var(--mono);
  font-weight: 400;
}

.use-port {
  flex: none;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.use-port:hover {
  background: var(--accent);
  color: #fff;
}

.app-edit-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.chk {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
}

.chk-group {
  display: inline-flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.foot-label {
  font-size: 12px;
  color: var(--text-2);
}

.foot-note {
  font-size: 12px;
  color: var(--gray);
}

.stack-note {
  font-size: 12px;
  color: var(--gray);
}

.host-owned-note {
  margin: 0 0 10px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  line-height: 1.5;
}

.env-fld {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

/* 文字型小按钮（取消 / 完成） */
.mini-btn {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-2);
  border-radius: 8px;
  padding: 6px 14px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
}

.mini-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

.mini-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.del-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  border-radius: 7px;
  padding: 3px 10px;
  font-size: 12.5px;
  cursor: pointer;
}

.del-btn:hover {
  border-color: var(--amber);
  background: var(--amber-soft);
  color: var(--amber);
}

.settings-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  font-size: 13px;
}

.settings-foot .err {
  color: var(--red);
}

.settings-foot .okmsg {
  color: var(--green);
}

.settings-foot .hint {
  color: var(--text-2);
  font-size: 12.5px;
}

.foot-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.primary-btn {
  border: none;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  padding: 7px 18px;
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
}

.primary-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (max-width: 640px) {
  .grid2,
  .grid3 {
    grid-template-columns: 1fr;
  }

  .settings-overlay,
  .editor-overlay {
    padding: 8px;
  }

  .settings-foot .hint {
    display: none;
  }
}
</style>
