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
const form = ref({ apps: [], remoteApps: [], page: {} })
const existingIds = ref(new Set())
const detectedApps = ref(new Map())

/** 当前正在编辑的条目：null 或 { list: 'apps' | 'remoteApps', index } */
const editing = ref(null)
const editingApp = computed(() => {
  if (!editing.value) return null
  return form.value[editing.value.list]?.[editing.value.index] ?? null
})
const editingIsRemote = computed(() => editing.value?.list === 'remoteApps')

/** 远程应用按归属拆分：外机（局域网其他主机）/ 公网（云服务器） */
const externalApps = computed(() =>
  form.value.remoteApps.map((a, i) => ({ a, i })).filter(({ a }) => a.env !== 'public'),
)
const publicApps = computed(() =>
  form.value.remoteApps.map((a, i) => ({ a, i })).filter(({ a }) => a.env === 'public'),
)

function openEditor(list, index) {
  editing.value = { list, index }
}

function closeEditor() {
  editing.value = null
}

const KIND_OPTIONS = [
  { value: 'web', label: 'Web' },
  { value: 'app', label: 'APP' },
  { value: 'miniapp', label: '小程序' },
  { value: 'tv', label: '电视' },
  { value: 'cli', label: 'CLI' },
]

function normalizeKinds(a) {
  const list = (a.kinds ?? []).filter((k) => KIND_OPTIONS.some((o) => o.value === k))
  if (list.length) return list
  return a.type === 'app' ? ['app'] : ['web']
}

function asList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  return []
}

function normalizeEntry(a, isRemote, detected) {
  const detectedKinds = detected?.kinds ?? []
  return {
    ...a,
    kinds: [...new Set([...normalizeKinds(a), ...detectedKinds.filter((k) => k !== 'web')])],
    env: a.env === 'lan' || a.env === 'public' ? a.env : (isRemote ? 'public' : 'lan'),
    https: Boolean(a.https),
    // 双向同步标记：勾选后由 monitor-server / settings-server 自动跨中心同步（仅远程应用有意义）
    ...(isRemote && a.monitorSync ? { monitorSync: true } : {}),
    languages: asList(a.languages),
    frontend: asList(a.frontend),
    backend: asList(a.backend),
  }
}

function listText(value) {
  return asList(value).join(', ')
}

function detectedStack(a) {
  const detected = detectedApps.value.get(a.id)
  if (!detected) return null
  return {
    languages: detected.languages ?? [],
    frontend: detected.frontend ?? [],
    backend: detected.backend ?? [],
  }
}

function detectedStackText(a) {
  const stack = detectedStack(a)
  if (!stack) return ''
  return [
    stack.languages.join('/'),
    stack.frontend.join(' + '),
    stack.backend.join(' + '),
  ].filter(Boolean).join(' · ')
}

function stackPlaceholder(a, key) {
  return (detectedStack(a)?.[key] ?? []).join(', ')
}

function setList(a, key, ev) {
  a[key] = ev.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
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

/** 列表行的摘要文案：应用形式 · 部署位置 · 端口/主机 */
function kindLabels(a) {
  return (a.kinds ?? []).map((k) => KIND_OPTIONS.find((o) => o.value === k)?.label).filter(Boolean)
}

function healthHost(a) {
  if (a.host) return a.host
  try {
    return new URL(a.healthUrl).host
  } catch {
    return ''
  }
}

function rowMeta(a, isRemote) {
  const parts = [...kindLabels(a), isRemote ? (a.env === 'public' ? '公网' : '外机') : '本机']
  if (isRemote) {
    const host = healthHost(a)
    if (host) parts.push(host)
  } else {
    const p = Number(a.expectedPort)
    if (a.expectedPort != null && a.expectedPort !== '' && !Number.isNaN(p)) parts.push(`:${p}`)
    if (a.https) parts.push('HTTPS')
  }
  return parts.join(' · ')
}

/** 当前探测到的实际端口（来自 apps.json） */
function detectedPort(a) {
  const port = detectedApps.value.get(a.id)?.port
  return Number.isInteger(port) ? port : null
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

async function load() {
  loading.value = true
  error.value = ''
  savedOk.value = false
  editing.value = null
  try {
    const res = await fetch('/api/config', { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const cfg = await res.json()
    let probedApps = new Map()
    try {
      const probed = await (await fetch(`./apps.json?t=${Date.now()}`, { cache: 'no-store' })).json()
      probedApps = new Map((probed.apps ?? []).map((a) => [a.id, a]))
    } catch {
      probedApps = new Map()
    }
    detectedApps.value = probedApps
    form.value = {
      apps: (cfg.apps ?? []).map((a) => normalizeEntry(a, false, probedApps.get(a.id))),
      remoteApps: (cfg.remoteApps ?? []).map((a) => normalizeEntry(a, true, probedApps.get(a.id))),
      page: { siteName: '', heroTitle: '', heroSubtitle: '', ...cfg.page },
    }
    existingIds.value = new Set([...(cfg.apps ?? []), ...(cfg.remoteApps ?? [])].map((a) => a.id))
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

function tagsText(a) {
  return (a.tags ?? []).join(', ')
}

function setTags(a, ev) {
  a.tags = ev.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}

function addLocal() {
  form.value.apps.push({ id: '', name: '', description: '', directory: '', expectedPort: null, kinds: ['web'], env: 'lan', https: false, languages: [], frontend: [], backend: [], github: '', tags: [], icon: '📦' })
  openEditor('apps', form.value.apps.length - 1)
}

function addRemote(env = 'lan') {
  const isPublic = env === 'public'
  form.value.remoteApps.push({
    id: '',
    name: '',
    description: '',
    healthUrl: '',
    url: '',
    location: isPublic ? '阿里云' : '内网服务器',
    host: '',
    kinds: ['web'],
    env: isPublic ? 'public' : 'lan',
    languages: [],
    frontend: [],
    backend: [],
    github: '',
    tags: [],
    icon: isPublic ? '☁️' : '🖥️',
  })
  openEditor('remoteApps', form.value.remoteApps.length - 1)
}

function removeApp(list, i) {
  if (window.confirm('确定删除该条目？保存后生效。')) {
    list.splice(i, 1)
    return true
  }
  return false
}

function removeEditing() {
  if (!editing.value) return
  if (removeApp(form.value[editing.value.list], editing.value.index)) closeEditor()
}

async function save() {
  saving.value = true
  error.value = ''
  savedOk.value = false
  const savedAt = Date.now()
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form.value),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)

    // 配置已写入，探测在后台执行（--no-fetch，1~2 秒完成）：立即反馈并关闭，
    // 父组件轮询 apps.json 的 probedAt，变化后自动刷新页面
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
          <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
        </header>

        <div v-if="loading" class="settings-tip">加载中…</div>
        <div v-else-if="error && !form.apps.length" class="settings-tip">{{ error }}</div>

        <div v-else class="settings-body">
          <!-- 页面信息 -->
          <section>
            <h3>页面信息</h3>
            <div class="grid3">
              <label class="fld"><span>站点名称（顶栏 / 浏览器标题）</span><input v-model="form.page.siteName" /></label>
              <label class="fld"><span>首页主标题</span><input v-model="form.page.heroTitle" /></label>
              <label class="fld"><span>首页副标题</span><input v-model="form.page.heroSubtitle" /></label>
            </div>
          </section>

          <!-- 本机应用：列表 + 点击弹窗编辑 -->
          <section>
            <h3>
              本机应用（{{ form.apps.length }}）
              <button class="mini-btn add-btn" @click="addLocal">＋ 添加</button>
            </h3>
            <div class="app-list">
              <button
                v-for="(a, i) in form.apps"
                :key="i"
                type="button"
                class="app-row"
                @click="openEditor('apps', i)"
              >
                <span class="app-row-icon">{{ a.icon }}</span>
                <span class="app-row-main">
                  <span class="app-row-name">
                    {{ a.name || a.id || '未命名应用' }}
                    <small class="mono">{{ a.id || '（新应用）' }}</small>
                  </span>
                  <span class="app-row-meta">{{ rowMeta(a, false) }}</span>
                </span>
                <span v-if="!a.id" class="tag">新</span>
                <span v-else-if="a.exclude" class="tag warn" title="已勾选「在主页隐藏」">已隐藏</span>
                <span class="app-row-arrow">›</span>
              </button>
            </div>
            <p class="list-hint">点击应用条目编辑详情</p>
          </section>

          <!-- 外机应用：局域网内其他主机，列表 + 点击弹窗编辑 -->
          <section>
            <h3>
              外机应用（{{ externalApps.length }}）
              <button class="mini-btn add-btn" @click="addRemote('lan')">＋ 添加</button>
            </h3>
            <div class="app-list">
              <button
                v-for="{ a, i } in externalApps"
                :key="i"
                type="button"
                class="app-row"
                @click="openEditor('remoteApps', i)"
              >
                <span class="app-row-icon">{{ a.icon }}</span>
                <span class="app-row-main">
                  <span class="app-row-name">
                    {{ a.name || a.id || '未命名应用' }}
                    <small class="mono">{{ a.id || '（新应用）' }}</small>
                  </span>
                  <span class="app-row-meta">{{ rowMeta(a, true) }}</span>
                </span>
                <span v-if="!a.id" class="tag">新</span>
                <span v-else-if="a.monitorSync" class="tag" title="已勾选「同步到监控中心」">已同步监控</span>
                <span v-else-if="a.syncSource === 'monitor'" class="tag" title="由监控中心同步创建（appSync）">来自监控</span>
                <span class="app-row-arrow">›</span>
              </button>
            </div>
            <p class="list-hint">部署在局域网内其他服务器上的应用，通过健康接口探测在线状态</p>
          </section>

          <!-- 公网应用：云服务器等公网主机，列表 + 点击弹窗编辑 -->
          <section>
            <h3>
              公网应用（{{ publicApps.length }}）
              <button class="mini-btn add-btn" @click="addRemote('public')">＋ 添加</button>
            </h3>
            <div class="app-list">
              <button
                v-for="{ a, i } in publicApps"
                :key="i"
                type="button"
                class="app-row"
                @click="openEditor('remoteApps', i)"
              >
                <span class="app-row-icon">{{ a.icon }}</span>
                <span class="app-row-main">
                  <span class="app-row-name">
                    {{ a.name || a.id || '未命名应用' }}
                    <small class="mono">{{ a.id || '（新应用）' }}</small>
                  </span>
                  <span class="app-row-meta">{{ rowMeta(a, true) }}</span>
                </span>
                <span v-if="!a.id" class="tag">新</span>
                <span v-else-if="a.monitorSync" class="tag" title="已勾选「同步到监控中心」">已同步监控</span>
                <span v-else-if="a.syncSource === 'monitor'" class="tag" title="由监控中心同步创建（appSync）">来自监控</span>
                <span class="app-row-arrow">›</span>
              </button>
            </div>
            <p class="list-hint">部署在云服务器等公网主机上的应用，通过健康接口探测在线状态</p>
          </section>
        </div>

        <footer class="settings-foot">
          <span v-if="error" class="err">{{ error }}</span>
          <span v-else-if="savedOk" class="okmsg">✓ 已保存，探测更新中，几秒内自动刷新…</span>
          <span v-else class="hint">保存后自动重跑探测，几秒内页面生效</span>
          <div class="foot-actions">
            <button class="mini-btn" :disabled="saving" @click="emit('close')">取消</button>
            <button class="primary-btn" :disabled="saving || loading" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </footer>
      </div>
    </div>

    <!-- 单个应用的编辑弹窗（嵌套在设置面板之上） -->
    <div v-if="open && editingApp" class="editor-overlay" @click.self="closeEditor">
      <div class="editor-panel" role="dialog" :aria-label="`编辑 ${editingApp.name || editingApp.id || '应用'}`">
        <header class="settings-head">
          <h2 class="editor-title">
            <span class="app-edit-icon">{{ editingApp.icon }}</span>
            {{ editingApp.name || editingApp.id || '未命名应用' }}
            <small class="mono">{{ editingApp.id || '（新应用）' }}</small>
          </h2>
          <button class="icon-btn" title="关闭" @click="closeEditor">✕</button>
        </header>

        <div class="settings-body editor-body">
          <!-- 本机应用编辑 -->
          <template v-if="!editingIsRemote">
            <div class="grid3">
              <label class="fld">
                <span>id{{ existingIds.has(editingApp.id) ? '（不可改）' : '' }}</span>
                <input v-model="editingApp.id" :readonly="existingIds.has(editingApp.id)" placeholder="目录名" />
              </label>
              <label class="fld"><span>图标 emoji</span><input v-model="editingApp.icon" /></label>
              <div class="fld">
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
              </div>
            </div>
            <div class="grid2">
              <label class="fld"><span>名称</span><input v-model="editingApp.name" /></label>
              <label class="fld"><span>标签（逗号分隔）</span><input :value="tagsText(editingApp)" @input="setTags(editingApp, $event)" /></label>
            </div>
            <label class="fld"><span>服务器目录</span><input v-model="editingApp.directory" class="mono" /></label>
            <label class="fld"><span>GitHub 地址</span><input v-model="editingApp.github" placeholder="https://github.com/…" /></label>
            <div class="grid3">
              <label class="fld"><span>主要语言（逗号分隔）</span><input :value="listText(editingApp.languages)" :placeholder="stackPlaceholder(editingApp, 'languages') || '如 Python, JavaScript'" @input="setList(editingApp, 'languages', $event)" /></label>
              <label class="fld"><span>前端框架</span><input :value="listText(editingApp.frontend)" :placeholder="stackPlaceholder(editingApp, 'frontend') || '如 Vue 3 + Vite'" @input="setList(editingApp, 'frontend', $event)" /></label>
              <label class="fld"><span>后端框架</span><input :value="listText(editingApp.backend)" :placeholder="stackPlaceholder(editingApp, 'backend') || '如 FastAPI'" @input="setList(editingApp, 'backend', $event)" /></label>
            </div>
            <span class="stack-note">自动识别：{{ detectedStackText(editingApp) || '未识别' }}（留空使用自动结果，填写后覆盖）</span>
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
                <span>部署位置</span>
                <span class="foot-note">本机（本服务器）</span>
              </div>
            </div>
            <div class="app-edit-foot">
              <span class="chk-group">
                <label class="chk" title="访问链接使用 https://（自签名证书会触发浏览器警告）">
                  <input v-model="editingApp.https" type="checkbox" /> 使用 HTTPS
                </label>
                <label class="chk"><input v-model="editingApp.exclude" type="checkbox" /> 在主页隐藏（exclude）</label>
                <label class="chk" title="本机应用的目录与端口已自动纳入监控中心跟踪，无需手动同步">
                  <input type="checkbox" checked disabled /> 监控自动跟踪
                </label>
              </span>
            </div>
          </template>

          <!-- 云服务器应用编辑 -->
          <template v-else>
            <div class="grid3">
              <label class="fld">
                <span>id{{ existingIds.has(editingApp.id) ? '（不可改）' : '' }}</span>
                <input v-model="editingApp.id" :readonly="existingIds.has(editingApp.id)" />
              </label>
              <label class="fld"><span>图标 emoji</span><input v-model="editingApp.icon" /></label>
              <label class="fld"><span>位置</span><input v-model="editingApp.location" placeholder="阿里云" /></label>
            </div>
            <div class="grid2">
              <label class="fld"><span>名称</span><input v-model="editingApp.name" /></label>
              <label class="fld"><span>主机 IP / 域名</span><input v-model="editingApp.host" class="mono" /></label>
            </div>
            <label class="fld"><span>健康接口 URL（必填）</span><input v-model="editingApp.healthUrl" class="mono" placeholder="http://…/api/v1/health" /></label>
            <label class="fld"><span>访问页面 URL（可选，默认取健康接口同源）</span><input v-model="editingApp.url" class="mono" /></label>
            <div class="grid2">
              <label class="fld"><span>GitHub 地址</span><input v-model="editingApp.github" /></label>
              <label class="fld"><span>标签（逗号分隔）</span><input :value="tagsText(editingApp)" @input="setTags(editingApp, $event)" /></label>
            </div>
            <div class="grid3">
              <label class="fld"><span>主要语言（逗号分隔）</span><input :value="listText(editingApp.languages)" placeholder="如 JavaScript, Node.js" @input="setList(editingApp, 'languages', $event)" /></label>
              <label class="fld"><span>前端框架</span><input :value="listText(editingApp.frontend)" placeholder="如 Vue 3" @input="setList(editingApp, 'frontend', $event)" /></label>
              <label class="fld"><span>后端框架</span><input :value="listText(editingApp.backend)" placeholder="如 Fastify" @input="setList(editingApp, 'backend', $event)" /></label>
            </div>
            <span class="stack-note">远程应用不在本机目录，技术栈需手动填写。</span>
            <div class="grid2">
              <label class="fld" title="配置后每轮探测通过 SSH 检查该目录的 git 同步状态（fetch + 工作区 + 未推送/未拉取）；公网机按线上语义展示：线上已改 / 线上提交未推送 = 违规（红），可拉取 = 待部署（橙）">
                <span>外机项目目录（可选，配置后检测其 git 同步）</span>
                <input v-model="editingApp.gitDir" class="mono" placeholder="/root/myapp" />
              </label>
              <label class="fld"><span>SSH 目标（可选，默认 root@主机）</span><input v-model="editingApp.gitSsh" class="mono" placeholder="root@10.8.11.3" /></label>
            </div>
            <label class="fld" title="推荐复用监控网关的专用密钥；留空则用系统默认身份">
              <span>SSH 私钥路径（可选）</span>
              <input v-model="editingApp.gitKey" class="mono" placeholder="/root/applications/my-homepage/data/monitor/keys/lan-1103" />
            </label>
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
              </span>
              <label class="env-fld">
                <span>部署位置</span>
                <select v-model="editingApp.env">
                  <option value="lan">外机（局域网）</option>
                  <option value="public">公网（云服务器）</option>
                </select>
              </label>
            </div>
            <div class="app-edit-foot">
              <span class="chk-group">
                <label class="chk" title="在监控中心自动创建/更新同名主机（地址=主机 IP，分组按公网/内网映射，gitDir 会预置为跟踪目录）。SSH 凭据需在监控设置中配置或用「自动部署」；取消勾选不会删除已创建的主机。">
                  <input v-model="editingApp.monitorSync" type="checkbox" /> 同步到监控中心
                </label>
              </span>
              <span v-if="editingApp.syncSource === 'monitor'" class="foot-note">该条目由监控中心同步创建（appSync），主机信息以监控设置为准</span>
            </div>
          </template>
        </div>

        <footer class="settings-foot">
          <button class="del-btn" @click="removeEditing">删除此条目</button>
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

.env-fld {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.env-fld select {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 8px;
  outline: none;
  cursor: pointer;
}

.env-fld select:focus {
  border-color: var(--accent);
}

/* 文字型小按钮（＋添加 / 取消 / 完成） */
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

.add-btn {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
}

.del-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--red);
  border-radius: 7px;
  padding: 3px 10px;
  font-size: 12.5px;
  cursor: pointer;
}

.del-btn:hover {
  border-color: var(--red);
  background: var(--red-soft);
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
