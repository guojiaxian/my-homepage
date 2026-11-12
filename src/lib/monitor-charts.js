/* ECharts 按需引入与图表配置（由 MonitorDetail 动态 import，独立异步分包，不占首屏） */
import * as echarts from 'echarts/core'
import { LineChart, BarChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

export { echarts }

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

export function createChart(el) {
  const inst = echarts.init(el)
  return inst
}

function axisCommon() {
  return {
    axisLine: { lineStyle: { color: cssVar('--border-strong') } },
    axisLabel: { color: cssVar('--text-2'), fontSize: 11 },
    splitLine: { lineStyle: { color: cssVar('--border'), type: 'dashed' } },
  }
}

export function timeAxisFormatter(range) {
  return range === '7d' ? '{MM}-{dd} {HH}:{mm}' : '{HH}:{mm}'
}

export function baseOption(yFmt, range = '1h') {
  const a = axisCommon()
  return {
    animationDuration: reducedMotion ? 0 : 400,
    animationDurationUpdate: reducedMotion ? 0 : 300,
    animationEasingUpdate: 'cubicOut',
    backgroundColor: 'transparent',
    /* containLabel：网格自动容纳 y 轴标签宽度——内存等窄区间刻度（如 61.85%）比
       固定 left:44 更宽，曾把标签挤出容器左缘被裁 */
    grid: { left: 8, right: 14, top: 26, bottom: 26, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      backgroundColor: cssVar('--bg-soft'),
      borderColor: cssVar('--border'),
      textStyle: { color: cssVar('--text'), fontSize: 12 },
    },
    xAxis: {
      type: 'time',
      axisLine: a.axisLine,
      axisLabel: { ...a.axisLabel, formatter: timeAxisFormatter(range), hideOverlap: true },
    },
    yAxis: { type: 'value', scale: true, axisLabel: { ...a.axisLabel, formatter: yFmt }, splitLine: a.splitLine },
  }
}

export function areaColor(hex) {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hex + '38' },
    { offset: 1, color: hex + '05' },
  ])
}

export function lineSeries(name, data, color, extra = {}) {
  return {
    name,
    type: 'line',
    data,
    smooth: 0.3,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width: 1.8, color },
    itemStyle: { color },
    areaStyle: extra.noArea ? undefined : { color: areaColor(color) },
    ...extra,
  }
}

export function legendStyle() {
  return { top: 0, textStyle: { color: cssVar('--text-2'), fontSize: 11 }, itemWidth: 14, itemHeight: 8 }
}

/* 水平条形通用（分区用量 / 目录占比） */
export function hBarOption(cats, values, opts = {}) {
  return {
    animationDuration: reducedMotion ? 0 : 400,
    animationDurationUpdate: reducedMotion ? 0 : 300,
    backgroundColor: 'transparent',
    grid: { left: opts.labelWidth || 120, right: 56, top: 6, bottom: 22 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: cssVar('--bg-soft'),
      borderColor: cssVar('--border'),
      textStyle: { color: cssVar('--text'), fontSize: 12 },
    },
    xAxis: {
      type: 'value',
      max: opts.max,
      axisLabel: { ...axisCommon().axisLabel, formatter: opts.xFmt || '{value}' },
      splitLine: axisCommon().splitLine,
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: cats,
      axisLabel: { ...axisCommon().axisLabel, fontSize: 11.5 },
    },
    series: [
      {
        type: 'bar',
        barWidth: 14,
        data: values,
        itemStyle: { borderRadius: 4 },
        label: {
          show: true,
          position: 'right',
          formatter: opts.labelFmt || ((p) => p.value),
          color: cssVar('--text-2'),
          fontSize: 11,
        },
      },
    ],
  }
}
