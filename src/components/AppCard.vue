<script setup>
import { ref } from 'vue'
import { buildAppUrl, copyText, envInfo, gitSyncView, hasUrl, kindList, portText, remoteHealthTitle, stackText, stackTitle, statusClass, statusText, statusTitle } from '../lib/app-utils.js'

const props = defineProps({
  apps: { type: Array, required: true },
  reorderable: { type: Boolean, default: false },
})

const emit = defineEmits(['move', 'move-all'])

const dragIdx = ref(-1)

function onDragStart(idx, ev) {
  dragIdx.value = idx
  if (ev?.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', props.apps[idx]?.id ?? String(idx))
    const card = ev.target?.closest?.('.card')
    if (card) ev.dataTransfer.setDragImage(card, 30, 30)
  }
}

/** 拖拽落点：把被拖卡片移到目标卡片位置（之前） */
function onDrop(targetIdx) {
  const from = dragIdx.value
  dragIdx.value = -1
  if (from < 0 || from === targetIdx || from >= props.apps.length) return
  const ids = props.apps.map((a) => a.id)
  const [movedId] = ids.splice(from, 1)
  ids.splice(targetIdx > from ? targetIdx - 1 : targetIdx, 0, movedId)
  emit('move-all', ids)
}

const copiedId = ref('')

async function copyDir(app) {
  if (await copyText(app.directory)) {
    copiedId.value = app.id
    setTimeout(() => {
      if (copiedId.value === app.id) copiedId.value = ''
    }, 1500)
  }
}
</script>

<template>
  <div class="card-grid">
    <article
      v-for="(app, idx) in apps"
      :key="app.id"
      class="card"
      :class="[envInfo(app).cls, dragIdx === idx ? 'dragging' : '']"
      @dragover.prevent
      @drop.prevent="onDrop(idx)"
    >
      <header class="card-head">
        <span
          v-if="reorderable"
          class="grip"
          draggable="true"
          title="按住拖拽调整顺序"
          @dragstart="onDragStart(idx, $event)"
          @dragend="dragIdx = -1"
        >
          <svg width="10" height="14" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="4" r="1.8" /><circle cx="11" cy="4" r="1.8" />
            <circle cx="5" cy="10" r="1.8" /><circle cx="11" cy="10" r="1.8" />
            <circle cx="5" cy="16" r="1.8" /><circle cx="11" cy="16" r="1.8" />
          </svg>
        </span>
        <span class="app-icon" :class="{ 'icon-net': envInfo(app).cls === 'net' }" aria-hidden="true">{{ app.icon }}</span>
        <div class="card-title">
          <h3>
            <span class="env-chip" :class="envInfo(app).cls">{{ envInfo(app).label }}</span>
            {{ app.name }}
            <span v-if="app.remoteInfo?.version" class="tag" :title="remoteHealthTitle(app)">v{{ app.remoteInfo.version }}</span>
            <span v-if="app.pending" class="tag warn" title="请在 scripts/apps.config.json 中补充信息">待补充</span>
          </h3>
          <span class="badge" :class="statusClass(app)" :title="statusTitle(app)">
            <span class="dot" />
            {{ statusText(app) }}
          </span>
        </div>
        <div v-if="reorderable" class="card-move">
          <button class="mini-btn" :disabled="idx === 0" title="上移" @click="emit('move', app.id, -1)">↑</button>
          <button class="mini-btn" :disabled="idx === apps.length - 1" title="下移" @click="emit('move', app.id, 1)">↓</button>
        </div>
      </header>

      <p class="card-desc">{{ app.description }}</p>

      <div class="card-facts">
        <div class="fact">
          <span class="fact-label">访问</span>
          <span v-if="app.appOnly" class="text-muted" title="该应用无 Web 服务入口">—</span>
          <a
            v-else-if="hasUrl(app)"
            class="port-link"
            :href="buildAppUrl(app)"
            target="_blank"
            rel="noopener"
          >:{{ portText(app) }} ↗</a>
          <span v-else class="port-link muted">:{{ portText(app) }}</span>
          <span v-if="app.extraPorts?.length" class="mono extra-ports">+{{ app.extraPorts.join(', ') }}</span>
          <span v-if="app.port && !app.external" class="tag neutral">仅本机</span>
        </div>
        <div class="fact">
          <span class="fact-label">{{ app.remote ? '位置' : '目录' }}</span>
          <span
            v-if="app.remote"
            class="mono dir"
            :title="`${app.location} · ${app.host}`"
          >{{ app.location }} · {{ app.host }}</span>
          <span
            v-else
            class="mono dir copyable"
            :title="copiedId === app.id ? '已复制' : '点击复制'"
            @click="copyDir(app)"
          >{{ copiedId === app.id ? '✓ 已复制' : app.directory }}</span>
        </div>
        <div class="fact">
          <span class="fact-label">技术栈</span>
          <span class="stack-text" :title="stackTitle(app)">{{ stackText(app) || '—' }}</span>
        </div>
        <div class="fact">
          <span class="fact-label">同步</span>
          <span v-if="gitSyncView(app.git)" class="sync-chip" :class="gitSyncView(app.git).cls" :title="gitSyncView(app.git).title">
            {{ gitSyncView(app.git).text }}
          </span>
          <span v-else class="text-muted">—</span>
        </div>
        <div class="fact">
          <span class="fact-label">源码</span>
          <a v-if="app.github" :href="app.github" target="_blank" rel="noopener">{{ app.github.replace('https://github.com/', '') }} ↗</a>
          <span v-else class="text-muted">—</span>
        </div>
      </div>

      <footer v-if="kindList(app).length" class="card-tags">
        <span
          v-for="k in kindList(app)"
          :key="k.value"
          :class="['kind-chip', k.value]"
          :title="`应用形式：${k.label}`"
        >{{ k.label }}</span>
      </footer>
    </article>
  </div>
</template>

<style scoped>
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}

.card {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-hover);
}

/* 内网蓝 / 公网橙：卡片左色边 + 图标底色 */
.card.lan {
  border-left: 3px solid var(--accent);
}

.card.net {
  border-left: 3px solid var(--amber);
}

.app-icon.icon-net {
  background: var(--amber-soft);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--accent-soft);
  display: grid;
  place-items: center;
  font-size: 20px;
  flex: none;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.card-move {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.mini-btn {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-soft);
  color: var(--text-2);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  display: grid;
  place-items: center;
  transition: all 0.12s ease;
}

.mini-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

.mini-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.grip {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 26px;
  color: var(--gray);
  cursor: grab;
}

.card.dragging {
  opacity: 0.45;
}

.card-title h3 {
  margin: 0;
  font-size: 15.5px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.card-desc {
  margin: 0;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-facts {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
}

.fact {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.fact-label {
  flex: none;
  width: 42px;
  color: var(--gray);
  font-size: 12px;
}

.stack-text {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.dir {
  color: var(--text-2);
  word-break: break-all;
}

.copyable:hover {
  color: var(--accent);
}

.extra-ports {
  color: var(--text-2);
}

.text-muted {
  color: var(--gray);
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
}
</style>
