<script setup>
import { ref } from 'vue'
import { buildAppUrl, copyText, envInfo, gitSyncView, hasUrl, kindList, portText, remoteHealthTitle, stackText, stackTitle, statusClass, statusText, statusTitle } from '../lib/app-utils.js'

defineProps({
  apps: { type: Array, required: true },
  sortKey: { type: String, default: 'default' },
  sortDir: { type: Number, default: 1 },
  reorderable: { type: Boolean, default: false },
})

const emit = defineEmits(['sort', 'move', 'drop-reorder'])

const dragId = ref('')

function onDragStart(id, ev) {
  dragId.value = id
  // Firefox 要求 setData 才会启动拖拽；拖拽影像用整行更直观
  if (ev?.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', id)
    const row = ev.target?.closest?.('tr')
    if (row) ev.dataTransfer.setDragImage(row, 24, 24)
  }
}

function onDrop(targetId) {
  const from = dragId.value
  dragId.value = ''
  if (from && from !== targetId) emit('drop-reorder', from, targetId)
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
  <div class="table-wrap">
    <table class="app-table">
      <thead>
        <tr>
          <th v-if="reorderable" class="col-handle" title="拖拽行调整顺序（保存在本浏览器）"></th>
          <th
            class="col-status sortable"
            :class="{ on: sortKey === 'status' }"
            title="按运行状态排序（再次点击切换方向）"
            @click="$emit('sort', 'status')"
          >
            状态<span v-if="sortKey === 'status'" class="arrow">{{ sortDir === 1 ? '▲' : '▼' }}</span>
          </th>
          <th
            class="sortable"
            :class="{ on: sortKey === 'name' }"
            title="按名称排序（再次点击切换方向）"
            @click="$emit('sort', 'name')"
          >
            应用<span v-if="sortKey === 'name'" class="arrow">{{ sortDir === 1 ? '▲' : '▼' }}</span>
          </th>
          <th class="col-desc">简介</th>
          <th
            class="sortable"
            :class="{ on: sortKey === 'port' }"
            title="按端口排序（再次点击切换方向）"
            @click="$emit('sort', 'port')"
          >
            访问地址<span v-if="sortKey === 'port'" class="arrow">{{ sortDir === 1 ? '▲' : '▼' }}</span>
          </th>
          <th>服务器 / 目录</th>
          <th
            class="sortable"
            :class="{ on: sortKey === 'git' }"
            title="按同步状态排序（未同步的在前，再次点击切换方向）"
            @click="$emit('sort', 'git')"
          >
            同步<span v-if="sortKey === 'git'" class="arrow">{{ sortDir === 1 ? '▲' : '▼' }}</span>
          </th>
          <th class="col-github">GitHub</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="app in apps"
          :key="app.id"
          :class="[dragId === app.id ? 'dragging' : '', envInfo(app).cls]"
          @dragover.prevent
          @drop.prevent="onDrop(app.id)"
        >
          <td v-if="reorderable" class="col-handle">
            <span
              class="grip"
              draggable="true"
              title="按住拖拽调整顺序"
              @dragstart="onDragStart(app.id, $event)"
              @dragend="dragId = ''"
            >
              <svg width="10" height="16" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="4" r="1.8" /><circle cx="11" cy="4" r="1.8" />
                <circle cx="5" cy="10" r="1.8" /><circle cx="11" cy="10" r="1.8" />
                <circle cx="5" cy="16" r="1.8" /><circle cx="11" cy="16" r="1.8" />
              </svg>
            </span>
          </td>
          <td class="col-status">
            <span
              class="badge"
              :class="statusClass(app)"
              :title="statusTitle(app)"
            >
              <span class="dot" />
              {{ statusText(app) }}
            </span>
          </td>
          <td>
            <div class="app-cell">
              <span class="app-icon" :class="{ 'icon-ext': envInfo(app).cls === 'ext', 'icon-net': envInfo(app).cls === 'net' }" aria-hidden="true">{{ app.icon }}</span>
              <div class="app-meta">
                <span class="app-name">
                  <span class="env-chip" :class="envInfo(app).cls">{{ envInfo(app).label }}</span>
                  {{ app.name }}
                  <span v-if="app.remoteInfo?.version" class="tag" :title="remoteHealthTitle(app)">v{{ app.remoteInfo.version }}</span>
                  <span v-if="app.pending" class="tag warn" title="请在 scripts/apps.config.json 中补充信息">待补充</span>
                </span>
                <span class="app-tags">
                  <span
                    v-for="k in kindList(app)"
                    :key="k.value"
                    :class="['kind-chip', k.value]"
                    :title="`应用形式：${k.label}`"
                  >{{ k.label }}</span>
                  <span v-if="stackText(app)" class="stack-text" :title="stackTitle(app)">{{ stackText(app) }}</span>
                </span>
              </div>
            </div>
          </td>
          <td class="col-desc">
            <span class="desc" :title="app.description">{{ app.description }}</span>
          </td>
          <td>
            <span v-if="app.appOnly" class="text-muted" title="该应用无 Web 服务入口">—</span>
            <a
              v-else-if="hasUrl(app)"
              class="port-link"
              :href="buildAppUrl(app)"
              target="_blank"
              rel="noopener"
              :title="buildAppUrl(app)"
            >:{{ portText(app) }} <span aria-hidden="true">↗</span></a>
            <span v-else class="port-link muted" title="未监听，不可访问">:{{ portText(app) }}</span>
            <span v-if="app.extraPorts?.length" class="extra-ports mono">+{{ app.extraPorts.join(', ') }}</span>
            <span v-if="app.port && !app.external" class="tag neutral" title="该服务仅监听 127.0.0.1，仅本机可访问">仅本机</span>
          </td>
          <td>
            <span
              v-if="app.remote"
              class="mono dir"
              :title="`${app.location} · ${app.host}`"
            >{{ app.location }} · {{ app.host }}</span>
            <span
              v-else
              class="mono dir copyable"
              :title="copiedId === app.id ? '已复制' : `${app.directory}（点击复制）`"
              @click="copyDir(app)"
            >{{ copiedId === app.id ? '✓ 已复制' : app.directory }}</span>
          </td>
          <td class="col-sync">
            <span v-if="gitSyncView(app.git)" class="sync-chip" :class="gitSyncView(app.git).cls" :title="gitSyncView(app.git).title">
              {{ gitSyncView(app.git).text }}
            </span>
            <span v-else class="text-muted">—</span>
          </td>
          <td class="col-github">
            <a v-if="app.github" :href="app.github" target="_blank" rel="noopener" title="查看源码">源码 ↗</a>
            <span v-else class="text-muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  overflow-x: auto;
}

.app-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 980px;
}

th {
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-2);
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

th.sortable {
  cursor: pointer;
  user-select: none;
}

th.sortable:hover {
  color: var(--text);
}

th.sortable.on {
  color: var(--accent);
}

th.sortable .arrow {
  font-size: 9px;
  margin-left: 3px;
}

td {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

tbody tr:last-child td {
  border-bottom: none;
}

tbody tr {
  transition: background 0.12s ease;
}

tbody tr:hover {
  background: var(--bg-hover);
}

.col-status {
  width: 92px;
}

.col-handle {
  width: 34px;
  padding: 14px 4px !important;
}

.grip {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--gray);
  cursor: grab;
  transition: all 0.12s ease;
}

.grip:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

tr.dragging {
  opacity: 0.45;
}

.col-desc {
  max-width: 520px;
  min-width: 220px;
}

.col-github {
  white-space: nowrap;
}

.app-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 340px;
  min-width: 340px;
}

.app-icon.icon-net {
  background: var(--amber-soft);
}

.app-icon.icon-ext {
  background: var(--green-soft);
}

/* 行首归属色条：本机蓝 / 外机绿 / 公网橙 */
tbody tr.lan td:first-child {
  border-left: 3px solid var(--accent);
}

tbody tr.ext td:first-child {
  border-left: 3px solid var(--green);
}

tbody tr.net td:first-child {
  border-left: 3px solid var(--amber);
}

.app-icon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--accent-soft);
  display: grid;
  place-items: center;
  font-size: 18px;
  flex: none;
}

.app-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 与简介列（3 行）等高，保证每行应用高度一致 */
  height: 63px;
  overflow: hidden;
}

.app-name {
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.app-tags {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  overflow: hidden;
}

.app-tags .kind-chip {
  flex: none;
}

.stack-text {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: normal;
  color: var(--text-2);
  font-size: 12px;
  line-height: 16px;
}

.desc {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  height: 63px;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.55;
}

.extra-ports {
  color: var(--text-2);
  margin-left: 6px;
}

.dir {
  color: var(--text-2);
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.copyable:hover {
  color: var(--accent);
}

.text-muted {
  color: var(--gray);
}

@media (max-width: 900px) {
  .app-table {
    min-width: 920px;
  }

  .col-desc {
    max-width: 340px;
  }
}
</style>
