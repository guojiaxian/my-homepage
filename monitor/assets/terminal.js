/* 独立终端页：/monitor/terminal.html?host=<id>（与主看板终端抽屉同一 WS 协议） */
'use strict';
(function () {
  const hostId = new URLSearchParams(location.search).get('host') || '';
  const statusEl = document.getElementById('term-status');
  const titleEl = document.getElementById('term-title');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  titleEl.textContent = '终端 · ' + hostId;
  document.title = '终端 · ' + hostId;

  let term, fit, ws;
  function status(txt, cls) { statusEl.textContent = txt; statusEl.className = 't-status ' + (cls || ''); }

  function connect() {
    if (ws) { try { ws.close(); } catch {} }
    if (term) { try { term.dispose(); } catch {} }
    document.getElementById('term-container').innerHTML = '';
    status('连接中…');
    term = new Terminal({
      fontFamily: "'Cascadia Code', Menlo, Consolas, monospace", fontSize: 13.5,
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#4493f8', selectionBackground: '#264f78' },
      cursorBlink: !reducedMotion, scrollback: 5000,
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('term-container'));
    fit.fit();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/terminal?host=${encodeURIComponent(hostId)}&cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { status('已连接 ' + hostId, 'ok'); term.focus(); };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return; }
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'error') { status('错误：' + msg.message, 'bad'); term.writeln('\r\n\x1b[31m' + msg.message + '\x1b[0m'); }
      } catch { /* 普通输入 */ }
    };
    ws.onclose = (ev) => status(ev.reason ? `已断开（${ev.reason}）` : '已断开', 'bad');
    ws.onerror = () => status('连接失败（未登录或网关不可达）', 'bad');
    term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
    term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  }
  window.addEventListener('resize', () => { if (fit) { try { fit.fit(); } catch {} } });
  document.getElementById('term-reconnect').addEventListener('click', connect);
  document.getElementById('term-close').addEventListener('click', () => { try { ws && ws.close(); } catch {}; window.close(); });
  connect();
})();
