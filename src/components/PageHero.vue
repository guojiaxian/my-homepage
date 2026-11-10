<script setup>
/* 两个顶层视图（应用中心 / 监控中心）共用的页头，保证切换时标题与统计区位置完全一致 */
defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
})
</script>

<template>
  <section class="hero">
    <h1>{{ title }}</h1>
    <p class="sub">{{ subtitle }}</p>
    <div class="stats">
      <slot />
    </div>
  </section>
</template>
