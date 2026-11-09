/* 监控中心前端 —— 零框架，ECharts 绘图 + xterm 终端；与主站视觉变量同源 */
/* eslint-disable no-undef */
'use strict';

/* ============================ 基础工具 ============================ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMb = (v) => (v == null || !isFinite(v) ? '-' : v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v.toFixed(0) + ' MB');
const fmtMbs = (v) => (v == null || !isFinite(v) ? '-' : v >= 100 ? v.toFixed(0) : v.toFixed(2));
const fmtPct = (v) => (v == null || !isFinite(v) ? '-' : v.toFixed(v >= 10 ? 0 : 1));
const fmtUptime = (s) => {
  if (!s && s !== 0) return '-';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}天${h}时` : h ? `${h}时${m}分` : `${m}分`;
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* 数字滚动过渡（rAF lerp，仅合成可读文本；reduced-motion 直接落值） */
function tickNum(el, to, fmt) {
  const target = Number(to);
  if (!isFinite(target)) { el.textContent = '-'; return; }
  const from = parseFloat(el.dataset.v ?? target) || 0;
  el.dataset.v = target;
  if (reducedMotion || Math.abs(target - from) < 0.005) { el.textContent = fmt(target); return; }
  cancelAnimationFrame(el._raf);
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 260), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (target - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

/* ============================ API ============================ */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) { showLogin(); throw new Error('未登录'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ============================ 全局状态 ============================ */
const state = {
  summary: null,
  detailHost: null,     // 详情页当前主机 id
  range: '1h',
  dirMetric: 'cpu',
  dirFilter: '',
  compareSet: new Set(),
  charts: {},           // key -> echarts instance
  procsCache: [],
  entered: false,       // 入场动画只播一次（吸取 glass 轮询闪烁教训）
  timer: null,
  histTimer: null,
  theme: localStorage.getItem('mh-monitor:theme') || 'light',
};

/* ============================ 登录 ============================ */
function showLogin() {
  stopPolling();
  $('#login').hidden = false;
  $('#app').hidden = true;
  setTimeout(() => $('#login-pw').focus(), 50);
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  try {
    await api('/api/monitor/login', { method: 'POST', body: { password: $('#login-pw').value } });
    $('#login-err').textContent = '';
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#login-pw').value = '';
    boot();
  } catch (err) {
    $('#login-err').textContent = err.message === '未登录' ? '会话失效，请重新登录' : err.message;
  } finally { btn.disabled = false; }
});

/* ============================ 主题 ============================ */
function applyTheme() { document.documentElement.dataset.theme = state.theme; }
applyTheme();
$('#btn-theme').addEventListener('click', () => {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('mh-monitor:theme', state.theme);
  applyTheme();
  Object.values(state.charts).forEach((c) => c && c.dispose());
  state.charts = {};
  if (state.detailHost) openDetail(state.detailHost, true);
});

/* ============================ 轮询 ============================ */
function startPolling() {
  stopPolling();
  state.timer = setInterval(refreshSummary, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSummary().catch(() => {});
  });
}
function stopPolling() { if (state.timer) clearInterval(state.timer); state.timer = null; }

async function refreshSummary() {
  if (document.hidden) return;
  try {
    state.summary = await api('/api/monitor/summary');
    if (!$('#app').hidden) { renderOverview(); renderAlerts(); }
  } catch (e) { /* 401 已由 api() 处理；其余静默下轮重试 */ }
}

/* ============================ 概览渲染 ============================ */
function renderOverview() {
  const s = state.summary;
  if (!s) return;
  $('#chip-hosts').textContent = s.hosts.length;
  const nOnline = s.hosts.filter((h) => h.online).length;
  $('#chip-hosts').textContent = `${nOnline}/${s.hosts.length}`;
  const alerts = s.alerts || [];
  $('#chip-alerts').hidden = alerts.length === 0;
  $('#chip-alerts-n').textContent = alerts.length;

  const groups = new Map();
  for (const h of s.hosts) {
    if (!groups.has(h.group)) groups.set(h.group, []);
    groups.get(h.group).push(h);
  }
  const wrap = $('#host-groups');
  if (!state.entered) {
    wrap.innerHTML = '<div class="skeleton"></div>';
    state.entered = true;
    setTimeout(() => renderOverview(), 120);
    return;
  }
  wrap.innerHTML = '';
  for (const [group, hosts] of groups) {
    const pub = /公网|public/i.test(group);
    const g = document.createElement('div');
    g.className = 'fade-up';
    g.innerHTML = `<div class="group-head"><span class="env-dot ${pub ? 'public' : ''}"></span>${esc(group)}
      <span class="sub">${hosts.filter((h) => h.online).length}/${hosts.length} 在线</span></div>
      <div class="host-grid">${hosts.map((h) => hostCardHtml(h, pub)).join('')}</div>`;
    wrap.appendChild(g);
  }
  $$('.host-card', wrap).forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openDetail(card.dataset.host);
    });
    const btnTerm = $('.term-open', card);
    if (btnTerm) btnTerm.addEventListener('click', () => openTerminal(card.dataset.host));
    const btnDetail = $('.detail-open', card);
    if (btnDetail) btnDetail.addEventListener('click', () => openDetail(card.dataset.host));
  });
  // 仪表与数字过渡
  $$('.gauge', wrap).forEach((el) => {
    el.style.setProperty('--gauge-v', el.dataset.v || 0);
    const lv = Number(el.dataset.v || 0);
    el.classList.toggle('level-warn', lv >= 70 && lv < 88);
    el.classList.toggle('level-crit', lv >= 88);
  });
  const up = $('#updated-at');
  up.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  $('#foot-time').textContent = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function hostCardHtml(h, pub) {
  const sn = h.snap;
  const online = h.online && sn && sn.online;
  const dotCls = online ? '' : (h.credReady ? 'err' : 'off');
  let body = '';
  if (!h.credReady) body = `<div class="hint">待配置凭据：${esc(h.note || '在设置中添加密钥或密码后自动开始采集')}</div>`;
  else if (!online) body = `<div class="hint">采集中 / 未连通：${esc(h.error || '等待首个探测周期')}</div>`;
  else {
    const cpu = sn.cpu?.pct, mem = sn.mem?.pct;
    const worstDisk = (sn.disks || []).filter((d) => d.pct != null).sort((a, b) => b.pct - a.pct)[0];
    body = `
      <div class="gauge-row">
        ${gaugeHtml('CPU', cpu)}
        ${gaugeHtml('内存', mem)}
        ${gaugeHtml('磁盘', worstDisk?.pct)}
        <div class="net-block">
          <div>负载 <span class="net-v num">${sn.cpu?.load1 ?? '-'} / ${sn.cpu?.loadPerCore ?? '-'}核</span></div>
          <div>↑ <span class="net-v num">${fmtMbs(sn.net?.outMbs)}</span> ↓ <span class="net-v num">${fmtMbs(sn.net?.inMbs)}</span> Mbps</div>
          <div>运行 ${fmtUptime(sn.uptimeSec)}</div>
        </div>
      </div>
      <div class="host-foot">
        <span class="hint">${(sn.dirs || []).length ? `跟踪 ${sn.dirs.length} 个目录 · 容器 ${sn.containersCount}` : '无跟踪目录命中'}</span>
        <button class="mini-btn detail-open">📈 详情</button>
        <button class="mini-btn term-open">⌨ 终端</button>
      </div>`;
  }
  return `<div class="host-card fade-up ${pub ? 'public' : ''} ${online ? '' : 'offline'}" data-host="${esc(h.id)}">
    <div class="host-top">
      <span class="status-dot ${dotCls}" title="${online ? '在线' : (h.credReady ? '离线：' + esc(h.error) : '待配置')}"></span>
      <span class="host-name">${esc(h.name)}</span>
      <span class="env-chip ${pub ? 'public' : ''}">${esc(h.group)}</span>
      <span class="spacer" style="flex:1"></span>
      <span class="host-addr">${esc(h.address || '')}</span>
    </div>
    <div class="host-os">${esc((sn && sn.os) || '')}</div>
    ${body}
  </div>`;
}
function gaugeHtml(cap, v, sub = '') {
  const val = v == null || !isFinite(v) ? 0 : v;
  return `<div class="gauge" data-v="${val.toFixed(1)}" title="${esc(cap)} ${fmtPct(v)}%">
    <span class="g-label"><span class="g-val num">${fmtPct(v)}</span><span class="g-cap">${esc(sub || cap)}</span></span>
  </div>`;
}

/* ============================ 告警 ============================ */
function renderAlerts() {
  const s = state.summary;
  const alerts = (s && s.alerts) || [];
  const el = $('#alerts-list');
  if (!alerts.length) { el.innerHTML = '<div class="alert-empty">当前无活跃告警 ✓</div>'; return; }
  el.innerHTML = alerts.map((a) => `
    <div class="alert-row ${a.level === 'warn' ? 'warn' : ''}">
      <span class="status-dot err"></span>
      <span class="a-label">${esc(a.label)}</span>
      <span class="a-meta">阈值 ${esc(a.threshold)} · 主机 ${esc(hostName(a.hostId))} · 自 ${esc(new Date(a.activeTs).toLocaleTimeString('zh-CN', { hour12: false }))}</span>
    </div>`).join('');
}
function hostName(id) { const h = state.summary?.hosts.find((x) => x.id === id); return h ? h.name : id; }

/* ============================ 详情页 ============================ */
const btnBack = $('#btn-back');
btnBack.addEventListener('click', () => { closeDetail(); });
$$('#range-tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#range-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  state.range = b.dataset.r;
  if (state.detailHost) loadDetailData(state.detailHost);
}));
$('#dir-metric').addEventListener('change', (e) => { state.dirMetric = e.target.value; renderDirsChart(); });

function openDetail(hostId, keep) {
  state.detailHost = hostId;
  state.dirFilter = '';
  state.compareSet.clear();
  if (!keep) $$('#range-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.r === '1h'));
  const h = state.summary?.hosts.find((x) => x.id === hostId);
  $('#detail-title').textContent = h ? h.name : hostId;
  $('#overview').hidden = true;
  $('#detail').hidden = false;
  $('#alerts-section').hidden = true;
  window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  loadDetailData(hostId);
  if (!state.histTimer) state.histTimer = setInterval(() => { if (state.detailHost && !document.hidden) loadDetailData(state.detailHost, true); }, 15000);
}
function closeDetail() {
  state.detailHost = null;
  $('#detail').hidden = true;
  $('#overview').hidden = false;
  $('#alerts-section').hidden = false;
  if (state.histTimer) clearInterval(state.histTimer);
  state.histTimer = null;
  renderOverview(); renderAlerts();
}

async function loadDetailData(hostId, silent) {
  const h = state.summary?.hosts.find((x) => x.id === hostId);
  if (!h) return;
  const sn = h.snap;
  $('#detail-meta').textContent = sn && sn.online
    ? `${sn.os || ''} · 运行 ${fmtUptime(sn.uptimeSec)} · CPU ${fmtPct(sn.cpu?.pct)}% · 内存 ${fmtPct(sn.mem?.pct)}%`
    : (h.error || '等待探测');
  try {
    const [hist, procs] = await Promise.all([
      api(`/api/monitor/hosts/${encodeURIComponent(hostId)}/history?range=${state.range}`),
      api(`/api/monitor/hosts/${encodeURIComponent(hostId)}/procs`),
    ]);
    state.hist = hist.points || [];
    state.procsCache = procs.procs || [];
    state.procsTotal = procs.procsTotal || procs.procs?.length || 0;
    state.dirsList = procs.dirs || [];
    $('#net-iface').textContent = (sn && sn.net?.iface) || '-';
    renderCharts(hostId);
    renderDirsChart();
    renderCompareList();
    renderProcs();
  } catch (e) { if (!silent) console.warn(e); }
}

function chart(key, elId) {
  if (!state.charts[key]) state.charts[key] = echarts.init($('#' + elId));
  return state.charts[key];
}
function axisCommon() {
  return {
    axisLine: { lineStyle: { color: cssVar('--border-strong') } },
    axisLabel: { color: cssVar('--text-2'), fontSize: 11 },
    splitLine: { lineStyle: { color: cssVar('--border'), type: 'dashed' } },
  };
}
function baseOption(yFmt) {
  const a = axisCommon();
  return {
    animationDuration: reducedMotion ? 0 : 400,
    animationDurationUpdate: reducedMotion ? 0 : 300,
    animationEasingUpdate: 'cubicOut',
    backgroundColor: 'transparent',
    grid: { left: 46, right: 16, top: 30, bottom: 40 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, backgroundColor: cssVar('--bg-soft'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 } },
    xAxis: { type: 'time', axisLine: a.axisLine, axisLabel: { ...a.axisLabel, formatter: state.range === '7d' ? '{MM}-{dd} {HH}:{mm}' : '{HH}:{mm}' } },
    yAxis: { type: 'value', axisLabel: { ...a.axisLabel, formatter: yFmt }, splitLine: a.splitLine },
  };
}
function areaColor(hex) {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hex + '38' }, { offset: 1, color: hex + '05' },
  ]);
}
function lineSeries(name, data, color, extra = {}) {
  return {
    name, type: 'line', data, smooth: 0.3, showSymbol: false, connectNulls: false,
    lineStyle: { width: 1.8, color }, itemStyle: { color }, areaStyle: extra.noArea ? undefined : { color: areaColor(color) },
    ...extra,
  };
}
function renderCharts(hostId) {
  const pts = state.hist || [];
  const t = (p) => p.t;
  const cpu = chart('cpu', 'chart-cpu');
  const thCpu = (state.cfgCache?.thresholds?.cpuPct) ?? 85;
  cpu.setOption({
    ...baseOption('{value}%'),
    yAxis: { ...baseOption('{value}%').yAxis, max: 100 },
    legend: { top: 0, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
    series: [
      lineSeries('CPU %', pts.map((p) => [t(p), p.cpu]), cssVar('--accent'), { markLine: pts.length ? { silent: true, symbol: 'none', lineStyle: { color: cssVar('--red'), type: 'dashed' }, label: { color: cssVar('--red'), fontSize: 10 }, data: [{ yAxis: thCpu, name: '阈值' }] } : undefined }),
      lineSeries('负载', pts.map((p) => [t(p), p.load]), cssVar('--amber'), { noArea: true }),
    ],
  }, { notMerge: true });

  const mem = chart('mem', 'chart-mem');
  mem.setOption({
    ...baseOption('{value}%'),
    yAxis: { ...baseOption('{value}%').yAxis, max: 100 },
    legend: { top: 0, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
    series: [
      lineSeries('内存 %', pts.map((p) => [t(p), p.mem]), cssVar('--purple')),
      lineSeries('Swap %', pts.map((p) => [t(p), p.swap]), cssVar('--teal'), { noArea: true }),
    ],
  }, { notMerge: true });

  const net = chart('net', 'chart-net');
  net.setOption({
    ...baseOption('{value}'),
    legend: { top: 0, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
    series: [
      lineSeries('下行 Mbps', pts.map((p) => [t(p), p.netI]), cssVar('--accent')),
      lineSeries('上行 Mbps', pts.map((p) => [t(p), p.netO]), cssVar('--green')),
    ],
  }, { notMerge: true });

  const dio = chart('dio', 'chart-dio');
  dio.setOption({
    ...baseOption('{value}'),
    legend: { top: 0, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
    series: [
      lineSeries('读 MB/s', pts.map((p) => [t(p), p.dioR]), cssVar('--teal')),
      lineSeries('写 MB/s', pts.map((p) => [t(p), p.dioW]), cssVar('--amber')),
    ],
  }, { notMerge: true });

  const last = [...pts].reverse().find((p) => p.disks && p.disks.length) || { disks: [] };
  const disk = chart('disk', 'chart-disk');
  disk.setOption({
    animationDuration: reducedMotion ? 0 : 400,
    backgroundColor: 'transparent',
    grid: { left: 130, right: 60, top: 10, bottom: 24 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: cssVar('--bg-soft'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 } },
    xAxis: { type: 'value', max: 100, axisLabel: { ...axisCommon().axisLabel, formatter: '{value}%' }, splitLine: axisCommon().splitLine },
    yAxis: { type: 'category', data: last.disks.map((d) => d.mnt), axisLabel: { ...axisCommon().axisLabel, fontSize: 11, fontFamily: 'monospace' } },
    series: [{
      type: 'bar', barWidth: 14,
      data: last.disks.map((d) => ({
        value: d.pct, itemStyle: { color: d.pct >= 90 ? cssVar('--red') : d.pct >= 75 ? cssVar('--amber') : cssVar('--accent'), borderRadius: 4 },
        label: { show: true, position: 'right', formatter: `${d.pct}% (${d.usedGb}/${d.totalGb}G)`, color: cssVar('--text-2'), fontSize: 11 },
      })),
    }],
  }, { notMerge: true });
}

function renderDirsChart() {
  const dirs = (state.dirsList || []).slice();
  const metric = state.dirMetric;
  dirs.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const top = dirs.slice(0, 12);
  const c = chart('dirs', 'chart-dirs');
  const yLabel = { cpu: 'CPU %', mem: '内存 MB', ioR: 'IO 读 MB/s', ioW: 'IO 写 MB/s', threads: '线程', fds: '句柄' }[metric];
  c.setOption({
    animationDuration: reducedMotion ? 0 : 400,
    animationDurationUpdate: reducedMotion ? 0 : 300,
    backgroundColor: 'transparent',
    grid: { left: 170, right: 70, top: 10, bottom: 24 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: cssVar('--bg-soft'), borderColor: cssVar('--border'), textStyle: { color: cssVar('--text'), fontSize: 12 } },
    xAxis: { type: 'value', axisLabel: { ...axisCommon().axisLabel, formatter: '{value}' }, splitLine: axisCommon().splitLine },
    yAxis: { type: 'category', inverse: true, data: top.map((d) => d.name + (d.source === 'container' ? ' ⬛' : '')), axisLabel: { ...axisCommon().axisLabel, fontSize: 12 } },
    series: [{
      type: 'bar', barWidth: 16,
      data: top.map((d, i) => ({
        value: +(d[metric] || 0).toFixed(2), dirPath: d.path,
        itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: cssVar('--accent') + 'cc' }, { offset: 1, color: cssVar('--accent') }]), borderRadius: 4 },
        label: { show: true, position: 'right', formatter: (p) => p.value, color: cssVar('--text-2'), fontSize: 11 },
      })),
    }],
  }, { notMerge: true });
  c.off('click');
  c.on('click', (params) => {
    const dir = params.data && params.data.dirPath;
    if (!dir) return;
    state.dirFilter = state.dirFilter === dir ? '' : dir;
    renderDirFilter();
    renderProcs();
    $('#procs-sub').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  });
}

function renderCompareList() {
  const wrap = $('#dir-compare-list');
  const dirs = state.dirsList || [];
  if (!dirs.length) { wrap.innerHTML = '<span class="sub">该主机无目录命中</span>'; chart('dircmp', 'chart-dircmp').setOption({ xAxis: { show: false }, yAxis: { show: false }, series: [] }); return; }
  wrap.innerHTML = dirs.map((d) => `<label class="dir-chip ${state.compareSet.has(d.path) ? 'on' : ''}" style="display:inline-flex;align-items:center;gap:4px">
    <input type="checkbox" data-dir="${esc(d.path)}" ${state.compareSet.has(d.path) ? 'checked' : ''} style="accent-color:var(--accent)" />${esc(d.name)}</label>`).join('');
  $$('input[data-dir]', wrap).forEach((cb) => cb.addEventListener('change', () => {
    const d = cb.dataset.dir;
    if (cb.checked) state.compareSet.add(d); else state.compareSet.delete(d);
    cb.closest('.dir-chip').classList.toggle('on', cb.checked);
    loadDirCompare();
  }));
  loadDirCompare();
}
async function loadDirCompare() {
  const dirs = [...state.compareSet];
  const c = chart('dircmp', 'chart-dircmp');
  if (!dirs.length) { c.setOption({ ...baseOption('{value}%'), legend: { show: false }, series: [] }, { notMerge: true }); return; }
  try {
    const res = await api(`/api/monitor/dirs/history?host=${encodeURIComponent(state.detailHost)}&range=${state.range}&dirs=${encodeURIComponent(dirs.join('|'))}`);
    const palette = ['--accent', '--purple', '--teal', '--amber', '--green', '--red'];
    c.setOption({
      ...baseOption('{value}%'),
      legend: { top: 0, textStyle: { color: cssVar('--text-2'), fontSize: 11 } },
      series: Object.entries(res.series).map(([path, rows], i) => lineSeries(
        (state.dirsList || []).find((d) => d.path === path)?.name || path,
        rows.map((r) => [r.t, r.cpu]), cssVar(palette[i % palette.length]), { noArea: i > 0 }
      )),
    }, { notMerge: true });
  } catch (e) { /* 静默 */ }
}

function renderDirFilter() {
  const wrap = $('#dir-filter');
  const dirs = state.dirsList || [];
  wrap.innerHTML = `<span class="dir-chip ${state.dirFilter === '' ? 'on' : ''}" data-dir="">全部</span>` +
    dirs.map((d) => `<span class="dir-chip ${state.dirFilter === d.path ? 'on' : ''}" data-dir="${esc(d.path)}">${esc(d.name)}</span>`).join('');
  $$('.dir-chip', wrap).forEach((chip) => chip.addEventListener('click', () => {
    state.dirFilter = chip.dataset.dir;
    renderDirFilter(); renderProcs();
  }));
}
function renderProcs() {
  renderDirFilter();
  const rows = state.procsCache.filter((p) => !state.dirFilter || p.dir === state.dirFilter)
    .sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0));
  $('#procs-sub').textContent = `共 ${state.procsCache.length} 个归属进程（主机总进程 ${state.procsTotal || '-'}），当前显示 ${rows.length}`;
  $('#procs-body').innerHTML = rows.map((p) => `<tr>
    <td class="num" title="${esc(p.cmd)}">${esc(p.name)}</td>
    <td><span class="dir-tag ${p.dir && p.dir.startsWith('docker:') ? 'container' : ''}">${esc(p.dirName || '-')}</span></td>
    <td class="num">${p.pid}</td>
    <td class="num">${p.cpuPct == null ? '-' : p.cpuPct.toFixed(2)}</td>
    <td class="num">${fmtMb(p.memMb)}</td>
    <td class="num">${fmtMbs(p.ioReadMbs)}</td>
    <td class="num">${fmtMbs(p.ioWriteMbs)}</td>
    <td class="num">${p.threads}</td>
    <td class="num">${p.fds || '-'}</td>
    <td>${esc(p.container || '-')}</td>
    <td class="proc-cmd" title="${esc(p.cmd)}">${esc(p.cmd)}</td>
  </tr>`).join('') || '<tr><td colspan="11" style="color:var(--text-2);text-align:center;padding:18px">无归属进程</td></tr>';
}

$('#btn-term-detail').addEventListener('click', () => { if (state.detailHost) openTerminal(state.detailHost); });

/* ============================ 终端抽屉 ============================ */
let termState = null; // {hostId, term, ws, fit}
function termStatus(txt, cls = '') { const el = $('#term-status'); el.textContent = txt; el.className = 't-status ' + cls; }
function openTerminal(hostId) {
  const h = state.summary?.hosts.find((x) => x.id === hostId);
  $('#term-drawer').hidden = false;
  $('#term-mask').hidden = false;
  $('#term-title').textContent = `终端 · ${h ? h.name : hostId}`;
  connectTerm(hostId);
}
function closeTerminal() {
  if (termState) { try { termState.ws && termState.ws.close(); } catch {} try { termState.term.dispose(); } catch {} }
  termState = null;
  $('#term-drawer').hidden = true;
  $('#term-mask').hidden = true;
}
function connectTerm(hostId) {
  if (termState) { try { termState.ws && termState.ws.close(); } catch {} try { termState.term.dispose(); } catch {} termState = null; }
  $('#term-container').innerHTML = '';
  termStatus('连接中…');
  const term = new Terminal({
    fontFamily: "'Cascadia Code', Menlo, Consolas, monospace", fontSize: 13.5,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#4493f8', selectionBackground: '#264f78' },
    cursorBlink: !reducedMotion, scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term-container'));
  fit.fit();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/terminal?host=${encodeURIComponent(hostId)}&cols=${term.cols}&rows=${term.rows}`);
  termState = { hostId, term, ws, fit };
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => termStatus('已连接 ' + hostId, 'ok');
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return; }
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'error') { termStatus('错误：' + msg.message, 'bad'); term.writeln('\r\n\x1b[31m' + msg.message + '\x1b[0m'); }
    } catch { /* 非控制帧 */ }
  };
  ws.onclose = (ev) => { if (termState && termState.ws === ws) termStatus(ev.reason ? `已断开（${ev.reason}）` : '已断开', 'bad'); };
  ws.onerror = () => termStatus('连接失败', 'bad');
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  term.focus();
}
$('#term-close').addEventListener('click', closeTerminal);
$('#term-mask').addEventListener('click', closeTerminal);
$('#term-reconnect').addEventListener('click', () => { if (termState) connectTerm(termState.hostId); });
$('#term-popout').addEventListener('click', () => { if (termState) window.open(`/monitor/terminal.html?host=${encodeURIComponent(termState.hostId)}`, '_blank', 'width=980,height=640'); });
window.addEventListener('resize', () => { if (termState && termState.fit) { try { termState.fit.fit(); } catch {} } Object.values(state.charts).forEach((c) => c && c.resize()); });

/* ============================ 设置弹窗 ============================ */
let editState = null;
$('#btn-settings').addEventListener('click', openSettings);
$('#foot-audit').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-cancel').addEventListener('click', closeSettings);
$('#settings-modal').addEventListener('click', (e) => { if (e.target === $('#settings-modal')) closeSettings(); });

async function openSettings() {
  $('#settings-modal').hidden = false;
  $('#settings-tip').textContent = '';
  try {
    const cfg = await api('/api/monitor/config');
    state.cfgCache = cfg;
    editState = JSON.parse(JSON.stringify({ hosts: cfg.hosts, trackedDirs: cfg.trackedDirs, thresholds: cfg.thresholds, collect: cfg.collect, terminal: cfg.terminal, webhookUrl: cfg.webhookUrl }));
    renderSettings();
    const auditRows = await api('/api/monitor/audit?limit=50');
    $('#audit-body').innerHTML = (auditRows.rows || []).map((r) => `<tr>
      <td class="num">${esc((r.ts || '').replace('T', ' ').slice(0, 19))}</td><td>${esc(r.event)}</td>
      <td>${esc(r.host || '-')}</td><td class="num">${esc(r.ip || '-')}</td>
      <td class="num">${r.durationSec != null ? r.durationSec + 's' : '-'}</td>
      <td>${esc(r.reason || r.keys || (r.commands && r.commands.slice(-3).join(' ; ')) || '')}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="color:var(--text-2)">暂无记录</td></tr>';
  } catch (e) { $('#settings-tip').textContent = '加载失败：' + e.message; }
}
function closeSettings() { $('#settings-modal').hidden = true; editState = null; }

function renderSettings() {
  const cfg = editState;
  // 主机
  $('#hosts-edit').innerHTML = cfg.hosts.map((h, i) => `
    <div class="host-edit" data-i="${i}">
      <div class="he-head"><b>${esc(h.id)}</b><span class="sub">${h.type === 'local' ? '本机' : 'SSH 远程'}</span>
        <span style="flex:1"></span>
        ${h.type === 'ssh' ? `<button class="mini-btn danger" data-del="${i}">删除</button>` : '<span class="sub">不可删除</span>'}</div>
      <div class="form-grid">
        <div class="form-item"><label>名称</label><input type="text" data-k="name" value="${esc(h.name)}" /></div>
        <div class="form-item"><label>分组（内网=蓝 / 公网=橙）</label><input type="text" data-k="group" value="${esc(h.group)}" /></div>
        ${h.type === 'ssh' ? `
          <div class="form-item"><label>地址</label><input type="text" data-k="address" value="${esc(h.address)}" /></div>
          <div class="form-item"><label>SSH 端口</label><input type="number" data-k="port" value="${h.port}" /></div>
          <div class="form-item"><label>用户名</label><input type="text" data-k="username" value="${esc(h.username)}" /></div>
          <div class="form-item"><label>认证</label><select data-k="authType"><option value="key" ${h.authType === 'key' ? 'selected' : ''}>密钥</option><option value="password" ${h.authType === 'password' ? 'selected' : ''}>密码</option></select></div>
          <div class="form-item" style="grid-column:span 2"><label>私钥路径（0600）</label><input type="text" data-k="keyPath" value="${esc(h.keyPath || '')}" /></div>
        ` : `
          <div class="form-item"><label>展示地址</label><input type="text" data-k="address" value="${esc(h.address || '')}" /></div>
          <div class="form-item"><label>终端主机</label><input type="text" data-k="t_host" value="${esc(h.terminal?.host || '127.0.0.1')}" /></div>
          <div class="form-item"><label>终端端口</label><input type="number" data-k="t_port" value="${h.terminal?.port || 22}" /></div>
          <div class="form-item"><label>终端用户</label><input type="text" data-k="t_username" value="${esc(h.terminal?.username || 'root')}" /></div>
          <div class="form-item"><label>认证</label><select data-k="t_authType"><option value="key" ${h.terminal?.authType === 'key' ? 'selected' : ''}>密钥</option><option value="password" ${h.terminal?.authType === 'password' ? 'selected' : ''}>密码</option></select></div>
          <div class="form-item"><label>私钥路径</label><input type="text" data-k="t_keyPath" value="${esc(h.terminal?.keyPath || '')}" /></div>
        `}
      </div>
      ${h.note ? `<div class="sub">${esc(h.note)}</div>` : ''}
    </div>`).join('');
  $$('#hosts-edit [data-del]').forEach((b) => b.addEventListener('click', () => {
    const i = +b.dataset.del;
    if (confirm(`删除主机 ${editState.hosts[i].id}？（保存后生效）`)) { editState.hosts.splice(i, 1); renderSettings(); }
  }));
  $$('#hosts-edit input, #hosts-edit select').forEach((inp) => inp.addEventListener('change', () => {
    const card = inp.closest('.host-edit');
    const h = editState.hosts[+card.dataset.i];
    const k = inp.dataset.k;
    if (k.startsWith('t_')) h.terminal = { ...(h.terminal || {}), [k.slice(2)]: k === 't_port' ? +inp.value : inp.value };
    else if (k === 'port') h.port = +inp.value;
    else h[k] = inp.value;
  }));
  // 目录
  $('#dirs-edit').innerHTML = cfg.trackedDirs.length
    ? cfg.trackedDirs.map((d, i) => `<div class="dir-row"><span class="d-path">${esc(d.path)}</span>
        <span class="d-src custom">自定义</span><button class="mini-btn danger" data-del="${i}">移除</button></div>`).join('')
    : '<div class="sub">暂无自定义跟踪目录</div>';
  $$('#dirs-edit [data-del]').forEach((b) => b.addEventListener('click', () => { editState.trackedDirs.splice(+b.dataset.del, 1); renderSettings(); }));
  // 阈值
  const thFields = [['cpuPct', 'CPU %'], ['memPct', '内存 %'], ['diskPct', '磁盘 %'], ['loadPerCore', '每核负载'], ['sustainMin', '持续分钟']];
  $('#thresholds-edit').innerHTML = thFields.map(([k, label]) => `<div class="form-item"><label>${label}</label><input type="number" step="0.1" data-th="${k}" value="${cfg.thresholds[k]}" /></div>`).join('');
  $$('#thresholds-edit input').forEach((inp) => inp.addEventListener('change', () => { editState.thresholds[inp.dataset.th] = +inp.value; }));
  // 采集
  const coFields = [['localIntervalSec', '本机采集间隔(秒)'], ['remoteIntervalSec', '远程采集间隔(秒)'], ['retentionDays', '历史保留(天)'], ['dockerRefreshSec', '容器映射刷新(秒)']];
  $('#collect-edit').innerHTML = coFields.map(([k, label]) => `<div class="form-item"><label>${label}</label><input type="number" data-co="${k}" value="${cfg.collect[k]}" /></div>`).join('');
  $$('#collect-edit input').forEach((inp) => inp.addEventListener('change', () => { editState.collect[inp.dataset.co] = +inp.value; }));
  const teFields = [['idleTimeoutMin', '终端空闲超时(分)'], ['maxSessionMin', '单会话上限(分)'], ['maxSessionsPerHost', '每主机并发会话']];
  $('#terminal-edit').innerHTML = teFields.map(([k, label]) => `<div class="form-item"><label>${label}</label><input type="number" data-te="${k}" value="${cfg.terminal[k]}" /></div>`).join('')
    + `<div class="form-item"><label>命令行审计</label><div class="check-row"><input type="checkbox" id="te-record" ${cfg.terminal.recordCommands ? 'checked' : ''} /> 记录回车提交的命令</div></div>`;
  $$('#terminal-edit input[type=number]').forEach((inp) => inp.addEventListener('change', () => { editState.terminal[inp.dataset.te] = +inp.value; }));
  $('#te-record').addEventListener('change', (e) => { editState.terminal.recordCommands = e.target.checked; });
  $('#webhook-edit').value = cfg.webhookUrl || '';
}
$('#host-add').addEventListener('click', () => {
  const id = 'host-' + Math.random().toString(36).slice(2, 6);
  editState.hosts.push({ id, name: '新主机', type: 'ssh', group: '内网', address: '', port: 22, username: 'root', authType: 'key', keyPath: '' });
  renderSettings();
});
$('#dir-add').addEventListener('click', async () => {
  const p = prompt('输入要跟踪的绝对目录路径（如 /opt/myapp）：');
  if (!p) return;
  if (!p.startsWith('/')) { alert('必须是绝对路径'); return; }
  if (p === '/') { alert('不允许跟踪根目录（不越界采集）'); return; }
  if (editState.trackedDirs.some((d) => d.path === p)) { alert('该目录已在列表中'); return; }
  editState.trackedDirs.push({ path: p, name: p.split('/').filter(Boolean).pop() || p, source: 'custom' });
  renderSettings();
});
$('#settings-save').addEventListener('click', async () => {
  try {
    await api('/api/monitor/config', { method: 'PUT', body: {
      hosts: editState.hosts, trackedDirs: editState.trackedDirs,
      thresholds: editState.thresholds, collect: editState.collect,
      terminal: editState.terminal, webhookUrl: $('#webhook-edit').value.trim(),
    } });
    $('#settings-tip').textContent = '已保存，正在热加载…';
    setTimeout(() => { $('#settings-tip').textContent = '已生效 ✓'; refreshSummary().catch(() => {}); }, 800);
  } catch (e) { $('#settings-tip').textContent = '保存失败：' + e.message; }
});
$('#pw-change').addEventListener('click', async () => {
  try {
    await api('/api/monitor/password', { method: 'POST', body: { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value } });
    $('#pw-old').value = ''; $('#pw-new').value = '';
    $('#settings-tip').textContent = '密码已修改，请重新登录';
    setTimeout(() => showLogin(), 800);
  } catch (e) { $('#settings-tip').textContent = '修改失败：' + e.message; }
});

/* ============================ 启动 ============================ */
async function boot() {
  $('#app').hidden = false;
  await refreshSummary().catch(() => {});
  startPolling();
  api('/api/monitor/config').then((c) => { state.cfgCache = c; $('#foot-retain').textContent = (c.collect?.retentionDays ?? 7) + ' 天'; }).catch(() => {});
}
/* 入口：先试一次 summary 判断会话 */
api('/api/monitor/summary').then((s) => {
  state.summary = s;
  $('#app').hidden = false;
  renderOverview(); renderAlerts();
  startPolling();
  return api('/api/monitor/config');
}).then((c) => { state.cfgCache = c; $('#foot-retain').textContent = (c.collect?.retentionDays ?? 7) + ' 天'; })
  .catch(() => { /* 401 → showLogin 已触发 */ });
