<script setup>
import { ref, watch } from 'vue'

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
const detectedPorts = ref(new Map())

const KIND_OPTIONS = [
  { value: 'web', label: 'Web' },
  { value: 'app', label: 'APP' },
  { value: 'miniapp', label: '小程序' },
]

function normalizeKinds(a) {
  const list = (a.kinds ?? []).filter((k) => KIND_OPTIONS.some((o) => o.value === k))
  if (list.length) return list
  return a.type === 'app' ? ['app'] : ['web']
}

function normalizeEntry(a, isRemote) {
  return {
    ...a,
    kinds: normalizeKinds(a),
    env: a.env === 'lan' || a.env === 'public' ? a.env : (isRemote ? 'public' : 'lan'),
    https: Boolean(a.https),
  }
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

/** 当前探测到的实际端口（来自 apps.json） */
function detectedPort(a) {
  const port = detectedPorts.value.get(a.id)
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
  try {
    const res = await fetch('/api/config', { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const cfg = await res.json()
    form.value = {
      apps: (cfg.apps ?? []).map((a) => normalizeEntry(a, false)),
      remoteApps: (cfg.remoteApps ?? []).map((a) => normalizeEntry(a, true)),
      page: { siteName: '', heroTitle: '', heroSubtitle: '', ...cfg.page },
    }
    existingIds.value = new Set([...(cfg.apps ?? []), ...(cfg.remoteApps ?? [])].map((a) => a.id))
    try {
      const probed = await (await fetch(`./apps.json?t=${Date.now()}`, { cache: 'no-store' })).json()
      detectedPorts.value = new Map((probed.apps ?? []).map((a) => [a.id, a.port]))
    } catch {
      detectedPorts.value = new Map()
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

function tagsText(a) {
  return (a.tags ?? []).join(', ')
}

function setTags(a, ev) {
  a.tags = ev.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}

function addLocal() {
  form.value.apps.push({ id: '', name: '', description: '', directory: '', expectedPort: null, kinds: ['web'], env: 'lan', https: false, github: '', tags: [], icon: '📦' })
}

function addRemote() {
  form.value.remoteApps.push({ id: '', name: '', description: '', healthUrl: '', url: '', location: '阿里云', host: '', kinds: ['web'], env: 'public', github: '', tags: [], icon: '☁️' })
}

function removeApp(list, i) {
  if (window.confirm('确定删除该条目？保存后生效。')) list.splice(i, 1)
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

          <!-- 本机应用 -->
          <section>
            <h3>
              本机应用
              <button class="mini-btn add-btn" @click="addLocal">＋ 添加</button>
            </h3>
            <fieldset v-for="(a, i) in form.apps" :key="i" class="app-edit">
              <div class="app-edit-head">
                <span class="app-edit-title">
                  <span class="app-edit-icon">{{ a.icon }}</span>
                  <b>{{ a.name || a.id || '未命名应用' }}</b>
                  <small class="mono">{{ a.id || '（新应用）' }}</small>
                  <span v-if="a.exclude" class="tag warn" title="已勾选「在主页隐藏」">已隐藏</span>
                </span>
                <button class="del-btn" @click="removeApp(form.apps, i)">删除</button>
              </div>
              <div class="grid3">
                <label class="fld">
                  <span>id{{ existingIds.has(a.id) ? '（不可改）' : '' }}</span>
                  <input v-model="a.id" :readonly="existingIds.has(a.id)" placeholder="目录名" />
                </label>
                <label class="fld"><span>图标 emoji</span><input v-model="a.icon" /></label>
                <div class="fld">
                  <span>期望端口 <small v-if="detectedPort(a)" class="port-hint">当前探测 :{{ detectedPort(a) }}</small></span>
                  <div class="port-row">
                    <input v-model="a.expectedPort" inputmode="numeric" placeholder="如 3000" />
                    <button
                      v-if="canAdoptPort(a)"
                      type="button"
                      class="use-port"
                      title="把实际探测端口写入期望端口"
                      @click="adoptPort(a)"
                    >
                      采用
                    </button>
                  </div>
                </div>
              </div>
              <div class="grid2">
                <label class="fld"><span>名称</span><input v-model="a.name" /></label>
                <label class="fld"><span>标签（逗号分隔）</span><input :value="tagsText(a)" @input="setTags(a, $event)" /></label>
              </div>
              <label class="fld"><span>服务器目录</span><input v-model="a.directory" class="mono" /></label>
              <label class="fld"><span>GitHub 地址</span><input v-model="a.github" placeholder="https://github.com/…" /></label>
              <label class="fld"><span>简介</span><textarea v-model="a.description" rows="2" /></label>
              <div class="app-edit-foot">
                <span class="chk-group">
                  <span class="foot-label">应用分类</span>
                  <label v-for="k in KIND_OPTIONS" :key="k.value" class="chk">
                    <input
                      type="checkbox"
                      :checked="hasKind(a, k.value)"
                      @change="toggleKind(a, k.value, $event.target.checked)"
                    />
                    {{ k.label }}
                  </label>
                  <span class="foot-note">未勾选 Web = 线下应用，不探测端口</span>
                </span>
                <label class="env-fld">
                  <span>部署位置</span>
                  <select v-model="a.env">
                    <option value="lan">内网</option>
                    <option value="public">公网</option>
                  </select>
                </label>
              </div>
              <div class="app-edit-foot">
                <span class="chk-group">
                  <label class="chk" title="访问链接使用 https://（自签名证书会触发浏览器警告）">
                    <input v-model="a.https" type="checkbox" /> 使用 HTTPS
                  </label>
                  <label class="chk"><input v-model="a.exclude" type="checkbox" /> 在主页隐藏（exclude）</label>
                </span>
              </div>
            </fieldset>
          </section>

          <!-- 云服务器应用 -->
          <section>
            <h3>
              云服务器应用（远程探查）
              <button class="mini-btn add-btn" @click="addRemote">＋ 添加</button>
            </h3>
            <fieldset v-for="(a, i) in form.remoteApps" :key="i" class="app-edit">
              <div class="app-edit-head">
                <span class="app-edit-title">
                  <span class="app-edit-icon">{{ a.icon }}</span>
                  <b>{{ a.name || a.id || '未命名应用' }}</b>
                  <small class="mono">{{ a.id || '（新应用）' }}</small>
                </span>
                <button class="del-btn" @click="removeApp(form.remoteApps, i)">删除</button>
              </div>
              <div class="grid3">
                <label class="fld">
                  <span>id{{ existingIds.has(a.id) ? '（不可改）' : '' }}</span>
                  <input v-model="a.id" :readonly="existingIds.has(a.id)" />
                </label>
                <label class="fld"><span>图标 emoji</span><input v-model="a.icon" /></label>
                <label class="fld"><span>位置</span><input v-model="a.location" placeholder="阿里云" /></label>
              </div>
              <div class="grid2">
                <label class="fld"><span>名称</span><input v-model="a.name" /></label>
                <label class="fld"><span>主机 IP / 域名</span><input v-model="a.host" class="mono" /></label>
              </div>
              <label class="fld"><span>健康接口 URL（必填）</span><input v-model="a.healthUrl" class="mono" placeholder="http://…/api/v1/health" /></label>
              <label class="fld"><span>访问页面 URL（可选，默认取健康接口同源）</span><input v-model="a.url" class="mono" /></label>
              <div class="grid2">
                <label class="fld"><span>GitHub 地址</span><input v-model="a.github" /></label>
                <label class="fld"><span>标签（逗号分隔）</span><input :value="tagsText(a)" @input="setTags(a, $event)" /></label>
              </div>
              <label class="fld"><span>简介</span><textarea v-model="a.description" rows="2" /></label>
              <div class="app-edit-foot">
                <span class="chk-group">
                  <span class="foot-label">应用分类</span>
                  <label v-for="k in KIND_OPTIONS" :key="k.value" class="chk">
                    <input
                      type="checkbox"
                      :checked="hasKind(a, k.value)"
                      @change="toggleKind(a, k.value, $event.target.checked)"
                    />
                    {{ k.label }}
                  </label>
                </span>
                <label class="env-fld">
                  <span>部署位置</span>
                  <select v-model="a.env">
                    <option value="lan">内网</option>
                    <option value="public">公网</option>
                  </select>
                </label>
              </div>
            </fieldset>
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

.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}

.settings-head h2 {
  margin: 0;
  font-size: 16px;
}

.settings-body {
  overflow-y: auto;
  padding: 6px 20px 16px;
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

.app-edit {
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  padding: 12px 16px 14px;
  margin: 0 0 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--bg-soft);
  box-shadow: var(--shadow);
}

.app-edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--border);
}

.app-edit-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14.5px;
  min-width: 0;
}

.app-edit-title small {
  color: var(--text-2);
  font-weight: 400;
}

.app-edit-icon {
  font-size: 17px;
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

.add-btn {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
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

  .settings-overlay {
    padding: 8px;
  }
}
</style>
