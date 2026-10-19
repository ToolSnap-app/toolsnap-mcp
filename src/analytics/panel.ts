/** HTML for the private analytics dashboard. Fetches /analytics/data client-side. */

export const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>toolsnap analytics</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/img/favicon-32.png" sizes="32x32" type="image/png">
<style>
  :root {
    --bg: #0e1117;
    --surface: #161b27;
    --border: #21293a;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #2f81f7;
    /* Darker than --accent specifically for filled controls carrying white
       text (seg-btn.active) — #2f81f7 + white text is 3.7:1, fails WCAG AA
       (4.5:1). This variant holds ~4.6:1. --accent itself stays untouched:
       it's used as a text/line color elsewhere, where it already passes. */
    --accent-strong: #1f6feb;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #a371f7;
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Fira Code", Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    background-image: radial-gradient(900px 360px at 50% -80px, rgba(47,129,247,0.08), transparent 70%);
    color: var(--text);
    font: 14px/1.5 var(--font-ui);
    min-height: 100vh;
  }
  header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.2px; display: flex; align-items: center; }
  header span { font-size: 12px; color: var(--muted); font-family: var(--font-mono); }
  .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); margin-left: 8px; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .refresh-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 5px 12px; border-radius: 7px; cursor: pointer; font: 12px var(--font-ui); transition: border-color 0.15s ease; }
  .refresh-btn:hover { border-color: var(--accent); }
  .refresh-btn:active { transform: scale(0.96); }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .error { background: #2d1b1b; border: 1px solid var(--red); border-radius: 8px; padding: 16px; color: var(--red); margin-bottom: 20px; font-size: 13px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: border-color 0.15s ease; }
  .kpi:hover { border-color: #2a3448; }
  .kpi-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; }
  .kpi-value { font-size: 28px; font-weight: 700; margin-top: 4px; letter-spacing: -0.5px; font-family: var(--font-mono); }
  .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .kpi-delta { font-size: 12px; font-weight: 600; margin-left: 6px; font-family: var(--font-mono); }
  .kpi-delta.up { color: var(--green); }
  .kpi-delta.down { color: var(--red); }
  .controls-bar { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .seg-group { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 3px; gap: 2px; }
  .seg-btn { background: transparent; border: none; color: var(--muted); font: 12px var(--font-ui); padding: 5px 11px; border-radius: 6px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
  .seg-btn:hover:not(.active) { color: var(--text); }
  .seg-btn.active { background: var(--accent-strong); color: #fff; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .grid3 { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: border-color 0.15s ease; }
  .card:hover { border-color: #2a3448; }
  .card h2 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; font-weight: 500; }
  .bar-chart { width: 100%; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; }
  .bar-label { width: 100px; color: var(--muted); text-align: right; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; display: flex; background: var(--border); border-radius: 3px; height: 14px; overflow: hidden; }
  /* No width transition: every render() call replaces the whole card's
     innerHTML, so bars are always painted at their final width — there's no
     persisting element to animate FROM, meaning the old width-transition
     rule never actually fired. Declaring it was still a layout-thrash
     anti-pattern (animating width forces reflow) with zero visual benefit;
     dropped rather than switched to transform, since these stacked flex
     segments (see errorRateChart) need real width to size correctly next to
     each other. */
  .bar-fill { height: 100%; border-radius: 3px; }
  .bar-count { width: 44px; text-align: right; color: var(--text); flex-shrink: 0; font-family: var(--font-mono); }
  .pay-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 20px; padding: 4px 10px; font-size: 12px; margin: 3px 2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .pay-count { color: var(--muted); font-family: var(--font-mono); }
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .stat-row:last-child { border-bottom: none; }
  .stat-val { font-weight: 600; font-family: var(--font-mono); }
  .green { color: var(--green); }
  .accent { color: var(--accent); }
  .yellow { color: var(--yellow); }
  .loading { text-align: center; padding: 60px 0; color: var(--muted); font-size: 13px; }
  .err-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .err-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
  .err-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .err-table tr:last-child td { border-bottom: none; }
  .err-table tr:hover td { background: rgba(255,255,255,0.02); }
  .err-detail { color: var(--muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .err-detail:hover { white-space: normal; overflow: visible; }
  .pager-bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 12px; color: var(--muted); }
  .pager-bar .seg-btn[disabled] { opacity: 0.35; cursor: default; }
  .pager-info { font-family: var(--font-mono); }
  .grid-wide { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; margin-bottom: 24px; }
  .retention-note { font-size: 12px; color: var(--muted); margin: -6px 0 14px; }
  .health-ok { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 9px 14px; color: var(--green); margin-bottom: 14px; font-size: 13px; }
  .health-note { color: var(--muted); font-size: 12px; margin: -8px 0 14px; }
  .error ul { margin: 6px 0 0 18px; }
  .refresh-btn[disabled] { opacity: 0.5; cursor: default; }
  .chart-wrap { position: relative; }
  .chart-wrap text { font-family: var(--font-mono); }
  .chart-empty { padding: 56px 0; text-align: center; color: var(--muted); font-size: 12px; }
  .chart-tip { position: absolute; top: 6px; left: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.45); pointer-events: none; white-space: nowrap; z-index: 5; }
  .tip-date { color: var(--muted); margin-bottom: 2px; }
  .tip-val { font-weight: 600; font-family: var(--font-mono); }
  @media (max-width: 768px) {
    .kpis { grid-template-columns: 1fr 1fr; }
    .grid2, .grid3, .grid-wide { grid-template-columns: 1fr; }
    .controls-bar { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  }
</style>
</head>
<body>
<header>
  <h1>toolsnap · analytics<span class="live-dot" title="live"></span></h1>
  <div style="display:flex;align-items:center;gap:12px">
    <span id="last-updated">loading…</span>
    <button class="refresh-btn" onclick="load(true)">↻ refresh</button>
  </div>
</header>
<main>
  <div id="root"><div class="loading">fetching data…</div></div>
</main>
<script>
const PAY_COLORS = {
  free_tool: '#7d8590',
  x402_paid: '#3fb950',
  x402_free_first: '#2f81f7',
  prepaid: '#a371f7',
  api_key: '#58a6ff',
  oauth: '#a371f7',
  '402_no_wallet': '#7d8590',
  '402_pay_failed': '#f85149',
  prepaid_insufficient: '#d29922',
  prepaid_rejected: '#e3b341',
  api_key_rejected: '#e3b341',
  api_key_insufficient: '#d29922',
  oauth_insufficient: '#d29922',
  deposit_success: '#58a6ff',
  deposit_failed: '#f85149',
  fiat_deposit_success: '#3fb950',
  fiat_deposit_failed: '#f85149',
  fiat_webhook_ignored: '#7d8590',
  settle_failed: '#f85149',
  tool_error: '#f85149',
};

const PAGE_SIZES = [10, 15, 25, 50];
const LS_KEY = 'ts_panel';
const state = {
  days: 30,
  view: 'line',
  internal: false,
  tab: 'overview',
  granularity: '1h', // intraday chart granularity, only used when days === 1
  pagers: {
    funnel: { page: 0, size: 15 },
    errors: { page: 0, size: 15 },
    purchases: { page: 0, size: 15 },
  },
};
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  if ([1, 7, 30, 90, 365].includes(saved.days)) state.days = saved.days;
  if (saved.view === 'line' || saved.view === 'bar') state.view = saved.view;
  if (saved.internal === true) state.internal = true;
  if (saved.tab === 'overview' || saved.tab === 'logs') state.tab = saved.tab;
  if (['30m', '1h', '4h'].includes(saved.granularity)) state.granularity = saved.granularity;
  if (saved.pagers) {
    for (const key of Object.keys(state.pagers)) {
      const size = saved.pagers[key] && saved.pagers[key].size;
      if (PAGE_SIZES.includes(size)) state.pagers[key].size = size;
    }
  }
} catch (e) {}
let lastData = null;

function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}
function setTimeframe(days) {
  state.days = days;
  saveState();
  if (lastData) render(lastData);
}
function setGranularity(g) {
  state.granularity = g;
  saveState();
  if (lastData) render(lastData);
}
function setView(view) {
  state.view = view;
  saveState();
  if (lastData) render(lastData);
}
function setInternal(on) {
  if (state.internal === on) return;
  state.internal = on;
  saveState();
  load(); // server-side filter — must refetch
}
function setTab(tab) {
  state.tab = tab;
  saveState();
  if (lastData) render(lastData);
}
function setPage(key, delta) {
  state.pagers[key].page = Math.max(0, state.pagers[key].page + delta);
  if (lastData) render(lastData);
}
function setPageSize(key, size) {
  state.pagers[key] = { page: 0, size };
  saveState();
  if (lastData) render(lastData);
}

function fmt(n, decimals = 2) {
  if (n === undefined || n === null) return '—';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  if (decimals === 0) return Math.round(n).toString();
  return Number(n).toFixed(decimals);
}

function fmtUsd(n) {
  if (n === undefined || n === null) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
  let s = v.toFixed(4).replace(/0+$/, '').replace(/\\.$/, '');
  if (s === '' || s === '-') s = '0';
  return '$' + s;
}

function barChart(items, valueKey, labelKey, color) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no data yet</div>';
  const max = Math.max(...items.map(i => i[valueKey] ?? 0), 1);
  return items.map(item => {
    const pct = Math.round(((item[valueKey] ?? 0) / max) * 100);
    return \`<div class="bar-row">
      <div class="bar-label" title="\${item[labelKey]}">\${item[labelKey]}</div>
      <div class="bar-track"><div class="bar-fill" style="width:\${pct}%;background:\${color}"></div></div>
      <div class="bar-count">\${fmt(item[valueKey], 0)}</div>
    </div>\`;
  }).join('');
}

function payChips(breakdown) {
  if (!breakdown || breakdown.length === 0) return '<div style="color:var(--muted);font-size:12px">no data yet</div>';
  const total = breakdown.reduce((s, b) => s + (b.calls ?? 0), 0);
  return breakdown.map(b => {
    const pct = total > 0 ? Math.round((b.calls / total) * 100) : 0;
    return \`<span class="pay-chip">
      <span class="dot" style="background:\${PAY_COLORS[b.type] ?? '#555'}"></span>
      \${b.type} <span class="pay-count">\${b.calls} · \${pct}%</span>
    </span>\`;
  }).join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeLabel(ts) {
  return new Date(ts).toISOString().slice(11, 19) + ' UTC · ' + new Date(ts).toISOString().slice(5, 10);
}

// Fase 24.7 — blockchain-explorer-style pagination: slice 'items' by the
// pager state keyed by 'key', return { pageItems, total }. pagerBar() renders
// the prev/next + page-size controls; both operate purely client-side since
// /analytics/data already returns the full bounded set in one GET.
function paginate(items, key) {
  const list = items || [];
  const pager = state.pagers[key];
  const total = list.length;
  const maxPage = Math.max(0, Math.ceil(total / pager.size) - 1);
  if (pager.page > maxPage) pager.page = maxPage;
  const start = pager.page * pager.size;
  return { pageItems: list.slice(start, start + pager.size), total, start };
}

function pagerBar(key, total) {
  const pager = state.pagers[key];
  if (total === 0) return '';
  const start = pager.page * pager.size + 1;
  const end = Math.min(total, start + pager.size - 1);
  const maxPage = Math.max(0, Math.ceil(total / pager.size) - 1);
  const sizeChips = PAGE_SIZES.map(n =>
    \`<button class="seg-btn \${pager.size === n ? 'active' : ''}" onclick="setPageSize('\${key}',\${n})">\${n}</button>\`
  ).join('');
  return \`<div class="pager-bar">
    <button class="seg-btn" \${pager.page === 0 ? 'disabled' : ''} onclick="setPage('\${key}',-1)">‹ prev</button>
    <span class="pager-info">\${start}–\${end} of \${total}</span>
    <button class="seg-btn" \${pager.page >= maxPage ? 'disabled' : ''} onclick="setPage('\${key}',1)">next ›</button>
    <span class="seg-group" style="margin-left:auto">\${sizeChips}</span>
  </div>\`;
}

// Fase 25.15 — colores de clase (ver LoggedFailureClass en queries.ts). Solo
// "paged" es rojo: es exactamente lo que sono en Telegram. Un internal que no
// pagino (probe o admin) se ve, pero apagado.
const CLASS_COLORS = { internal: '#f85149', upstream: '#d29922', caller: '#6e7681', payment: '#e3b341', money: '#f85149' };
function classDot(e) {
  const color = e.paged ? CLASS_COLORS.internal : (e.class === 'internal' ? '#484f58' : (CLASS_COLORS[e.class] ?? '#555'));
  const label = e.paged ? 'paged' : (e.class === 'internal' ? 'internal · muted' : e.class);
  return \`<span class="dot" style="background:\${color};display:inline-block;margin-right:5px"></span>\${esc(label)}\`;
}

function errorTable(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no errors 🎉</div>';
  const { pageItems, total } = paginate(items, 'errors');
  const rows = pageItems.map(e => \`<tr>
    <td>\${timeLabel(e.ts)}</td>
    <td>\${esc(e.tool)}</td>
    <td title="\${esc(e.type)}">\${classDot(e)}</td>
    <td title="\${esc(e.client)}">\${esc(e.client_name || (e.client || '').slice(0, 24) || '—')}</td>
    <td title="\${esc(e.payer)}">\${esc(truncatePayer(e.payer))}</td>
    <td class="err-detail" title="\${esc(e.detail)}">\${esc(e.detail) || '—'}</td>
  </tr>\`).join('');
  return \`<table class="err-table">
    <thead><tr><th>Time</th><th>Tool</th><th>Class</th><th>Client</th><th>Payer</th><th>Detail</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\${pagerBar('errors', total)}\`;
}

// Fase 24.7 — truncate a long payer id (wallet address or acct:<uuid>) the
// same way error-alerts.ts truncatePayer does, for the credit purchases log.
function truncatePayer(payer) {
  const s = String(payer ?? '');
  if (s.length > 16) return s.slice(0, 10) + '…' + s.slice(-4);
  return s;
}

// Fase 24.7 — individual credit purchases, both rails (crypto x402 deposit,
// fiat Polar checkout). Replays (revenue 0, detail starting "replay") are
// still shown here (unlike the summary card) so a redelivered webhook is
// auditable, just visually muted.
function creditPurchasesTable(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no credit purchases yet</div>';
  const { pageItems, total } = paginate(items, 'purchases');
  const rows = pageItems.map(p => {
    const rail = p.type === 'fiat_deposit_success' ? 'fiat' : 'crypto';
    const railColor = rail === 'fiat' ? '#3fb950' : '#58a6ff';
    const isReplay = (p.detail || '').startsWith('replay');
    return \`<tr style="\${isReplay ? 'opacity:0.5' : ''}">
      <td>\${timeLabel(p.ts)}</td>
      <td><span class="dot" style="background:\${railColor};display:inline-block;margin-right:5px"></span>\${rail}</td>
      <td title="\${esc(p.payer)}">\${esc(truncatePayer(p.payer))}</td>
      <td>\${fmtUsd(p.amount)}</td>
      <td class="err-detail" title="\${esc(p.detail)}">\${esc(p.detail) || '—'}</td>
    </tr>\`;
  }).join('');
  return \`<table class="err-table">
    <thead><tr><th>Time</th><th>Rail</th><th>Account</th><th>Amount</th><th>Note</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\${pagerBar('purchases', total)}\`;
}

// Fase 24.6 / 25.9 — tres clases de error, mismo clasificador que decide que
// suena en Telegram (error-classification.ts):
//   rojo   our_errors      → fallo real de ToolSnap. ES LO UNICO QUE PAGINA.
//   ambar  upstream_errors → el sitio destino fallo (4xx/5xx, SPA, redirects).
//   gris   caller_errors   → el agente llamo mal a la tool (falta un argumento).
// Solo el segmento rojo pide arreglo inmediato; un tramo gris que se come una
// barra entera dice otra cosa distinta y tambien util: la tool se esta
// explicando mal a los agentes.
function errorRateChart(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no errors yet</div>';
  return items.map(item => {
    const caller = item.caller_errors || 0;
    const muted = item.muted_errors || 0;
    const pct = n => item.total > 0 ? Math.round((n / item.total) * 100) : 0;
    return \`<div class="bar-row">
    <div class="bar-label" title="\${esc(item.tool)}">\${esc(item.tool)}</div>
    <div class="bar-track">
      <div class="bar-fill" style="width:\${pct(item.our_errors)}%;background:#f85149" title="our_errors (paged): \${item.our_errors}"></div>
      <div class="bar-fill" style="width:\${pct(item.upstream_errors)}%;background:#d29922" title="upstream_errors: \${item.upstream_errors}"></div>
      <div class="bar-fill" style="width:\${pct(caller)}%;background:#6e7681" title="caller_errors: \${caller}"></div>
      <div class="bar-fill" style="width:\${pct(muted)}%;background:#484f58" title="internal, not paged (probe/admin): \${muted}"></div>
    </div>
    <div class="bar-count" title="ours: \${item.our_errors} · upstream: \${item.upstream_errors} · caller: \${caller} · muted: \${muted}">\${item.errors}/\${item.total}</div>
  </div>\`;
  }).join('');
}

// Fase 25.17 — "Calls by surface" con dos tramos por cliente: llamadas reales
// (azul) y de escaner/directorio (gris). El resto de tarjetas solo cuentan lo real.
function surfaceBars(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no data yet</div>';
  const byClient = new Map();
  items.forEach(function (it) {
    const a = byClient.get(it.client) || { client: it.client, real: 0, scanner: 0 };
    if (it.probe) a.scanner += it.calls; else a.real += it.calls;
    byClient.set(it.client, a);
  });
  const rows = Array.from(byClient.values()).sort(function (a, b) { return (b.real + b.scanner) - (a.real + a.scanner); });
  const max = Math.max.apply(null, rows.map(function (r) { return r.real + r.scanner; }).concat([1]));
  const pct = function (n) { return Math.round((n / max) * 100); };
  const bars = rows.map(function (r) {
    const count = fmt(r.real, 0) + (r.scanner > 0 ? ' <span style="color:var(--muted)">+' + fmt(r.scanner, 0) + '</span>' : '');
    return '<div class="bar-row">'
      + '<div class="bar-label" title="' + esc(r.client) + '">' + esc(r.client) + '</div>'
      + '<div class="bar-track">'
      + '<div class="bar-fill" style="width:' + pct(r.real) + '%;background:#2f81f7" title="real: ' + r.real + '"></div>'
      + '<div class="bar-fill" style="width:' + pct(r.scanner) + '%;background:#484f58" title="scanner / directory probe: ' + r.scanner + '"></div>'
      + '</div>'
      + '<div class="bar-count" style="width:auto;min-width:44px;white-space:nowrap" title="real: ' + r.real + ' · scanner: ' + r.scanner + '">' + count + '</div>'
      + '</div>';
  }).join('');
  return '<div class="retention-note" style="margin-top:-6px">blue = real calls · grey = scanners and directory probes</div>' + bars;
}

// Fase 25.17 — franja de estado sobre las pestanas: verde si no hay tools
// rotas, el ultimo evento tiene menos de 3 h y ningun cron falla; si no, lista
// lo que falla. Mismo findBrokenTools que el cron de salud (payload health).
function healthStrip(h) {
  if (!h) return '';
  const SILENCE_MS = 3 * 60 * 60 * 1000;
  const problems = [];
  const notes = [];
  (h.broken_tools || []).forEach(function (b) {
    problems.push('tool failing for everyone: ' + b.tool + ' · ' + b.errors + '/' + b.total + ' real calls failed in 6h (' + b.pct + '%)' + (b.topDetail ? ' · ' + b.topDetail : ''));
  });
  if (h.last_event_ts == null) problems.push('no events recorded yet');
  else if (Date.now() - h.last_event_ts > SILENCE_MS) problems.push('silence: last event ' + timeLabel(h.last_event_ts));
  (h.crons || []).forEach(function (c) {
    if (!c.last_error) return;
    if (c.last_ok_ts != null && c.last_error_ts != null && c.last_error_ts < c.last_ok_ts) return;
    const line = 'cron ' + c.name + ' failing: ' + c.last_error + (c.last_error_ts ? ' (' + timeLabel(c.last_error_ts) + ')' : '');
    (c.muted ? notes : problems).push(line);
  });
  const noteHtml = notes.length ? '<div class="health-note">' + notes.map(esc).join(' · ') + '</div>' : '';
  if (problems.length === 0) {
    const okTitle = (h.crons || []).map(function (c) { return c.name + ': ' + (c.last_ok_ts ? timeLabel(c.last_ok_ts) : 'no mark yet'); }).join(' | ');
    return '<div class="health-ok" title="' + esc('last ok (5-min crons refresh hourly): ' + okTitle) + '">all clear · last event ' + esc(timeLabel(h.last_event_ts)) + '</div>' + noteHtml;
  }
  return '<div class="error"><strong>Needs attention</strong><ul>' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>' + noteHtml;
}

// Fase 24.6 — directory/registry scraper coverage, last 7 days.
function directoryCoverageTable(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no probe traffic in 7d</div>';
  const rows = items.map(r => \`<tr>
    <td>\${esc(r.client)}</td>
    <td>\${fmt(r.hits, 0)}</td>
    <td>\${timeLabel(r.last_seen)}</td>
  </tr>\`).join('');
  return \`<table class="err-table">
    <thead><tr><th>Directory</th><th>Connects · 7d</th><th>Last seen</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// Fase 25.3 — approximate week-over-week delta for a cumulative counter
// (Smithery useCount) sampled ~once/day: compares the latest point to the
// point ~7 samples back, not a sum-of-days like windowDelta (which fits a
// per-day flow, not a running total).
function smitheryDelta(series) {
  if (!series || series.length < 2) return null;
  const current = series[series.length - 1].use_count;
  const idx = Math.max(0, series.length - 8);
  if (idx === series.length - 1) return null;
  const past = series[idx].use_count;
  if (past === 0) return null;
  const pct = Math.round(((current - past) / past) * 100);
  return { pct, up: current >= past };
}

// Fase 25.3 — external directory-listing stats (Smithery useCount, Glama
// presence), latest daily snapshot per source.
function directoryStatsTable(stats, smitherySeries) {
  if (!stats || stats.length === 0) return '<div style="color:var(--muted);font-size:12px">no directory snapshots yet</div>';
  const delta = smitheryDelta(smitherySeries);
  const rows = stats.map(r => \`<tr>
    <td>\${esc(r.source)}</td>
    <td>\${r.use_count !== null ? fmt(r.use_count, 0) + (r.source === 'smithery' ? deltaBadge(delta) : '') : '—'}</td>
    <td>\${timeLabel(r.ts)}</td>
  </tr>\`).join('');
  return \`<table class="err-table">
    <thead><tr><th>Source</th><th>useCount</th><th>Last snapshot</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// Fase 24.6 — agents that hit the x402 paywall vs. converted within 7 days.
// Direct signal for whether the actionable 402 error.message (Fase 24.5)
// recovers the conversion an agent loses when it only sees a bare
// "Payment required" and never finds wallet_setup or /checkout.
function paywallFunnelStat(pf, label) {
  if (!pf || pf.hit_payers === 0) {
    return '<div style="color:var(--muted);font-size:12px">no paywall hits in ' + label + '</div>';
  }
  const pct = Math.round((pf.converted_payers / pf.hit_payers) * 100);
  return \`
    <div class="stat-row"><span>Agents hit the paywall</span><span class="stat-val accent">\${fmt(pf.hit_payers, 0)}</span></div>
    <div class="stat-row"><span>Converted within 7d</span><span class="stat-val green">\${fmt(pf.converted_payers, 0)}</span></div>
    <div class="stat-row"><span>Conversion rate</span><span class="stat-val yellow">\${pct}%</span></div>
  \`;
}

// Fase 24.6 — per-tool p50/p95 latency, top 10 by volume.
function latencyByToolTable(items) {
  if (!items || items.length === 0) return '<div style="color:var(--muted);font-size:12px">no latency data</div>';
  const rows = items.map(r => \`<tr>
    <td>\${esc(r.tool)}</td>
    <td>\${fmt(r.calls, 0)}</td>
    <td>\${r.p50_latency_ms} ms</td>
    <td>\${r.p95_latency_ms} ms</td>
  </tr>\`).join('');
  return \`<table class="err-table">
    <thead><tr><th>Tool</th><th>Calls</th><th>p50</th><th>p95</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// Fase 24 — per-surface funnel table (connect -> call -> family-complete -> paid).
function surfaceFunnelTable(surface) {
  const funnel = (surface && surface.funnel_by_client) || [];
  // Fase 25.17 — connects_by_client trae una fila por (cliente, probe): el embudo solo cuenta los reales.
  const connects = new Map();
  ((surface && surface.connects_by_client) || []).forEach(r => { if (!r.probe) connects.set(r.client, (connects.get(r.client) || 0) + r.connects); });
  const revenue = new Map((surface && surface.revenue_by_client || []).map(r => [r.client, r.revenue]));
  if (funnel.length === 0 && connects.size === 0) {
    return '<div style="color:var(--muted);font-size:12px">no connections yet</div>';
  }
  // Sorted by connects desc for a stable, meaningful default order — the
  // Set iteration order it used to rely on is otherwise insertion order,
  // which flips arbitrarily once this table is paginated.
  const clientsSorted = Array.from(new Set([...connects.keys(), ...funnel.map(f => f.client)]))
    .sort((a, b) => (connects.get(b) ?? 0) - (connects.get(a) ?? 0));
  const { pageItems, total } = paginate(clientsSorted, 'funnel');
  const rows = pageItems.map(client => {
    const f = funnel.find(x => x.client === client) || { sessions: 0, sessions_with_call: 0, sessions_family_complete: 0, sessions_paid: 0 };
    const pct = (num, den) => den > 0 ? Math.round((num / den) * 100) + '%' : '—';
    return \`<tr>
      <td>\${esc(client)}</td>
      <td>\${fmt(connects.get(client) ?? 0, 0)}</td>
      <td>\${fmt(f.sessions_with_call, 0)} <span style="color:var(--muted)">(\${pct(f.sessions_with_call, f.sessions)})</span></td>
      <td>\${fmt(f.sessions_family_complete, 0)} <span style="color:var(--muted)">(\${pct(f.sessions_family_complete, f.sessions)})</span></td>
      <td>\${fmt(f.sessions_paid, 0)} <span style="color:var(--muted)">(\${pct(f.sessions_paid, f.sessions)})</span></td>
      <td>\${fmtUsd(revenue.get(client) ?? 0)}</td>
    </tr>\`;
  }).join('');
  return \`<table class="err-table">
    <thead><tr><th>Surface</th><th>Connects · 7d</th><th>≥1 call</th><th>≥3 same family</th><th>Paid</th><th>Revenue</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\${pagerBar('funnel', total)}\`;
}

// Fase 25.15 — la ventana que siguen las tarjetas. 24h/7d/30d tienen corte
// propio en el payload (by_window, mismas filas leidas); 90d y 1y no (habria
// que leer 365 d de eventos en cada carga), asi que ensenan 30d y lo dicen.
function win() {
  return state.days === 1 ? 'h24' : state.days === 7 ? 'd7' : 'd30';
}
function winLabel() {
  return state.days === 1 ? '24h' : state.days === 7 ? '7d' : '30d';
}
function windowStats(d) {
  const w = d.by_window && d.by_window[win()];
  return w || { calls: 0, revenue: 0, unique_payers: 0, unique_anon_agents: 0, avg_latency_ms: 0, p50_latency_ms: 0, p95_latency_ms: 0, top_tools: [], payment_breakdown: [], calls_by_client: [], paywall_funnel: { hit_payers: 0, converted_payers: 0 }, error_rate_by_tool: [], latency_by_tool: [] };
}

// Fase 25.15 — con 90d/1y los eventos empiezan en retention.oldest_event_ts.
// Fase 25.17 — los connects (y los directorios) cubren
// retention.surface_days (7 d): D1 cobra una fila por connect leido.
function retentionNotice(d) {
  const r = d.retention;
  if (!r) return '';
  const parts = [];
  const surf = r.surface_days || r.connect_days;
  if (state.days > surf) parts.push('connects and directory coverage cover ' + surf + 'd');
  if (state.days > 30) {
    const oldest = r.oldest_event_ts ? new Date(r.oldest_event_ts).toISOString().slice(0, 10) : null;
    parts.push('per-window cards show 30d');
    if (oldest) parts.push('events since ' + oldest);
    parts.push('events kept ' + r.events_days + 'd');
  }
  if (parts.length === 0) return '';
  return '<div class="retention-note">' + esc(parts.join(' · ')) + '</div>';
}

// ---------------------------------------------------------------------------
// Time-series helpers: zero-fill, weekly bucketing, deltas.
// ---------------------------------------------------------------------------

function zeroFillDaily(raw, valueKey, days) {
  const map = new Map((raw || []).map(r => [r.day, r[valueKey]]));
  const now = new Date();
  const endUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = endUTC - i * 86400000;
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, value: map.get(day) ?? 0 });
  }
  return out;
}

function bucketWeekly(daily) {
  const rem = daily.length % 7;
  const trimmed = rem ? daily.slice(rem) : daily;
  const weeks = [];
  for (let i = 0; i < trimmed.length; i += 7) {
    const chunk = trimmed.slice(i, i + 7);
    const sum = chunk.reduce((s, c) => s + c.value, 0);
    weeks.push({ day: chunk[0].day, value: sum });
  }
  return weeks;
}

// Fase 24.7 — TradingView-style intraday views. The server returns 30-minute
// buckets over the last 7 days (ts = bucket start, ms epoch); zero-fill to
// a fixed-length series ending "now", then re-aggregate client-side into
// coarser granularities — same fetch-once-rebucket-client-side pattern as
// zeroFillDaily/bucketWeekly, just at a finer grain.
function zeroFillIntraday(raw, valueKey, hours, bucketMs) {
  const map = new Map((raw || []).map(r => [r.ts, r[valueKey]]));
  const nowBucket = Math.floor(Date.now() / bucketMs) * bucketMs;
  const count = Math.floor((hours * 3600000) / bucketMs);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = nowBucket - i * bucketMs;
    out.push({ day: new Date(t).toISOString(), value: map.get(t) ?? 0 });
  }
  return out;
}

function bucketIntraday(series, factor) {
  if (factor <= 1) return series;
  const out = [];
  for (let i = 0; i < series.length; i += factor) {
    const chunk = series.slice(i, i + factor);
    out.push({ day: chunk[0].day, value: chunk.reduce((s, c) => s + c.value, 0) });
  }
  return out;
}

const GRANULARITY_MS = { '30m': 1800000, '1h': 3600000, '4h': 14400000 };

function sumSeries(arr) {
  return arr.reduce((s, x) => s + x.value, 0);
}

function windowDelta(dailyArr, days) {
  const n = dailyArr.length;
  const prevStart = n - days * 2;
  if (prevStart < 0) return null;
  const current = dailyArr.slice(n - days);
  const previous = dailyArr.slice(prevStart, n - days);
  const curSum = sumSeries(current);
  const prevSum = sumSeries(previous);
  if (prevSum === 0) return null;
  const pct = Math.round(((curSum - prevSum) / prevSum) * 100);
  return { pct, up: curSum >= prevSum };
}

function deltaBadge(delta) {
  if (!delta) return '';
  const cls = delta.up ? 'up' : 'down';
  const arrow = delta.up ? '▲' : '▼';
  return \` <span class="kpi-delta \${cls}">\${arrow} \${Math.abs(delta.pct)}%</span>\`;
}

function tfLabel(days) {
  return { 1: '24h', 7: '7d', 30: '30d', 90: '90d', 365: '1y' }[days] || (days + 'd');
}

// ---------------------------------------------------------------------------
// Chart rendering: nice axis scaling + line/bar SVG + hover tooltip.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function niceMax(max) {
  if (!max || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  const norm = max / base;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

// Fase 24.7 — intraday series carry a full ISO datetime in 'day' (not a
// date-only string) so the label/tooltip can show HH:MM.
function formatXLabel(dayStr, gran) {
  if (gran === 'intraday') {
    const dt = new Date(dayStr);
    return String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0');
  }
  const dt = new Date(dayStr + 'T00:00:00Z');
  const d = dt.getUTCDate(), m = MONTHS[dt.getUTCMonth()];
  return gran === 'week' ? m : (d + ' ' + m);
}

function formatFullDate(dayStr, gran) {
  if (gran === 'intraday') {
    const dt = new Date(dayStr);
    const d = dt.getUTCDate(), m = MONTHS[dt.getUTCMonth()];
    const hh = String(dt.getUTCHours()).padStart(2, '0'), mm = String(dt.getUTCMinutes()).padStart(2, '0');
    return d + ' ' + m + ' ' + hh + ':' + mm + ' UTC';
  }
  const dt = new Date(dayStr + 'T00:00:00Z');
  const d = dt.getUTCDate(), m = MONTHS[dt.getUTCMonth()], y = dt.getUTCFullYear();
  return gran === 'week' ? ('week of ' + d + ' ' + m + ' ' + y) : (d + ' ' + m + ' ' + y);
}

function valueFormatter(kind) {
  return kind === 'usd' ? fmtUsd : (v => fmt(v, 0));
}

function timeChart(series, opts) {
  const fmtV = valueFormatter(opts.kind);
  if (!series || series.length === 0 || series.every(s => s.value === 0)) {
    return '<div class="chart-empty">no activity in this period</div>';
  }
  const W = 560, H = 200, ML = 46, MR = 12, MT = 10, MB = 24;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const n = series.length;
  const maxVal = Math.max(...series.map(s => s.value));
  const niceMaxVal = niceMax(maxVal);
  const xAt = i => n === 1 ? ML + plotW / 2 : ML + (i / (n - 1)) * plotW;
  const yAt = v => niceMaxVal === 0 ? (MT + plotH) : MT + plotH - (v / niceMaxVal) * plotH;

  let grid = '';
  const GRID_STEPS = 4;
  for (let g = 0; g <= GRID_STEPS; g++) {
    const v = niceMaxVal * g / GRID_STEPS;
    const y = yAt(v);
    grid += \`<line x1="\${ML}" y1="\${y}" x2="\${W - MR}" y2="\${y}" stroke="var(--border)" stroke-width="1" opacity="\${g === 0 ? 0.9 : 0.45}"/>\`;
    grid += \`<text x="\${ML - 6}" y="\${y + 3}" text-anchor="end" font-size="9" fill="var(--muted)">\${fmtV(v)}</text>\`;
  }

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  let xLabels = '';
  for (let i = 0; i < n; i++) {
    if (i !== n - 1 && i % labelEvery !== 0) continue;
    xLabels += \`<text x="\${xAt(i)}" y="\${H - 6}" text-anchor="middle" font-size="9" fill="var(--muted)">\${formatXLabel(series[i].day, opts.granularity)}</text>\`;
  }

  let viz = '';
  if (state.view === 'bar') {
    const bw = Math.max(2, (plotW / n) * 0.6);
    viz = series.map((s, i) => {
      const y = yAt(s.value);
      const h = Math.max((MT + plotH) - y, 0);
      return \`<rect x="\${xAt(i) - bw / 2}" y="\${y}" width="\${bw}" height="\${h}" fill="\${opts.color}" rx="2"/>\`;
    }).join('');
  } else {
    const pts = series.map((s, i) => \`\${xAt(i)},\${yAt(s.value)}\`).join(' ');
    const areaPts = \`\${xAt(0)},\${MT + plotH} \${pts} \${xAt(n - 1)},\${MT + plotH}\`;
    const gid = 'g' + Math.random().toString(36).slice(2, 9);
    const lastX = xAt(n - 1), lastY = yAt(series[n - 1].value);
    viz = \`<defs><linearGradient id="\${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="\${opts.color}" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="\${opts.color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="\${areaPts}" fill="url(#\${gid})"/>
      <polyline points="\${pts}" fill="none" stroke="\${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="\${lastX}" cy="\${lastY}" r="3" fill="\${opts.color}"/>
      <text x="\${lastX}" y="\${lastY - 10}" text-anchor="\${n > 1 ? 'end' : 'middle'}" font-size="10" font-weight="600" fill="\${opts.color}">\${fmtV(series[n - 1].value)}</text>\`;
  }

  const seriesAttr = esc(JSON.stringify(series.map(s => ({ d: s.day, v: s.value }))));

  return \`<div class="chart-wrap">
    <svg viewBox="0 0 \${W} \${H}" width="100%" style="overflow:visible;display:block"
      onmousemove="chartHover(event, this)" onmouseleave="chartLeave(this)"
      data-series="\${seriesAttr}" data-kind="\${opts.kind}" data-gran="\${opts.granularity}"
      data-ml="\${ML}" data-mr="\${MR}" data-mt="\${MT}" data-mb="\${MB}" data-w="\${W}" data-h="\${H}">
      \${grid}
      \${viz}
      \${xLabels}
      <line class="hover-guide" x1="0" y1="\${MT}" x2="0" y2="\${MT + plotH}" stroke="var(--border)" stroke-width="1" style="display:none"/>
      <circle class="hover-dot" r="4" fill="\${opts.color}" stroke="var(--bg)" stroke-width="2" style="display:none"/>
      <rect x="\${ML}" y="\${MT}" width="\${plotW}" height="\${plotH}" fill="transparent" pointer-events="all"/>
    </svg>
    <div class="chart-tip" style="display:none"></div>
  </div>\`;
}

function chartHover(evt, svgEl) {
  try {
    const series = JSON.parse(svgEl.getAttribute('data-series'));
    const kind = svgEl.getAttribute('data-kind');
    const gran = svgEl.getAttribute('data-gran');
    const W = +svgEl.getAttribute('data-w');
    const ML = +svgEl.getAttribute('data-ml'), MR = +svgEl.getAttribute('data-mr');
    const MT = +svgEl.getAttribute('data-mt'), MB = +svgEl.getAttribute('data-mb');
    const H = +svgEl.getAttribute('data-h');
    const plotW = W - ML - MR, plotH = H - MT - MB;
    const n = series.length;

    const rect = svgEl.getBoundingClientRect();
    const scaleX = W / rect.width;
    const xUser = (evt.clientX - rect.left) * scaleX;
    let idx = n === 1 ? 0 : Math.round(((xUser - ML) / plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));

    const point = series[idx];
    const maxVal = Math.max(...series.map(s => s.v));
    const niceMaxVal = niceMax(maxVal);
    const xAt = n === 1 ? ML + plotW / 2 : ML + (idx / (n - 1)) * plotW;
    const yAt = niceMaxVal === 0 ? MT + plotH : MT + plotH - (point.v / niceMaxVal) * plotH;

    const guide = svgEl.querySelector('.hover-guide');
    const dot = svgEl.querySelector('.hover-dot');
    if (guide) { guide.setAttribute('x1', xAt); guide.setAttribute('x2', xAt); guide.style.display = ''; }
    if (dot) { dot.setAttribute('cx', xAt); dot.setAttribute('cy', yAt); dot.style.display = ''; }

    const wrap = svgEl.closest('.chart-wrap');
    const tip = wrap && wrap.querySelector('.chart-tip');
    if (tip) {
      const fmtV = valueFormatter(kind);
      const unit = kind === 'usd' ? '' : ' calls';
      tip.innerHTML = '<div class="tip-date">' + formatFullDate(point.d, gran) + '</div><div class="tip-val">' + fmtV(point.v) + unit + '</div>';
      const leftPct = (xAt / W) * 100;
      tip.style.left = leftPct + '%';
      tip.style.transform = leftPct > 65 ? 'translateX(calc(-100% - 6px))' : 'translateX(6px)';
      tip.style.display = 'block';
    }
  } catch (e) {}
}

function chartLeave(svgEl) {
  const guide = svgEl.querySelector('.hover-guide');
  const dot = svgEl.querySelector('.hover-dot');
  if (guide) guide.style.display = 'none';
  if (dot) dot.style.display = 'none';
  const wrap = svgEl.closest('.chart-wrap');
  const tip = wrap && wrap.querySelector('.chart-tip');
  if (tip) tip.style.display = 'none';
}

function controlsBar() {
  const frames = [[1, '24h'], [7, '7d'], [30, '30d'], [90, '90d'], [365, '1y']];
  const chips = frames.map(([days, label]) =>
    \`<button class="seg-btn \${state.days === days ? 'active' : ''}" aria-pressed="\${state.days === days}" onclick="setTimeframe(\${days})">\${label}</button>\`
  ).join('');
  // Fase 24.7 — TradingView-style intraday granularity, only meaningful (and
  // only shown) when the 24h timeframe is active; daily timeframes bucket by
  // calendar day/week instead.
  const granChips = ['30m', '1h', '4h'].map(g =>
    \`<button class="seg-btn \${state.granularity === g ? 'active' : ''}" aria-pressed="\${state.granularity === g}" onclick="setGranularity('\${g}')">\${g}</button>\`
  ).join('');
  const views = [['line', '⟋ line'], ['bar', '▥ bars']];
  const viewChips = views.map(([v, label]) =>
    \`<button class="seg-btn \${state.view === v ? 'active' : ''}" aria-pressed="\${state.view === v}" onclick="setView('\${v}')">\${label}</button>\`
  ).join('');
  const sources = [[false, 'external'], [true, '+ internal']];
  const sourceChips = sources.map(([on, label]) =>
    \`<button class="seg-btn \${state.internal === on ? 'active' : ''}" aria-pressed="\${state.internal === on}" onclick="setInternal(\${on})">\${label}</button>\`
  ).join('');
  return \`<div class="controls-bar">
    <div class="seg-group">\${chips}</div>
    \${state.days === 1 ? \`<div class="seg-group">\${granChips}</div>\` : ''}
    <div class="seg-group">\${viewChips}</div>
    <div class="seg-group" title="external = real demand only; + internal also counts our own dev/testing traffic">\${sourceChips}</div>
  </div>\`;
}

// Fase 24.7 — Credits card replaces the old crypto-only "Deposits" card:
// cash-in split by rail (crypto x402 deposit / fiat Polar checkout) for the
// window, plus the lifetime liability straight from the balances table
// (source of truth for money, not derived from events).
function creditsCard(credits) {
  const c = credits || { purchased_30d: { crypto: { count: 0, total_usdc: 0 }, fiat: { count: 0, total_usdc: 0 } }, outstanding_usdc: 0, lifetime_purchased_usdc: 0, lifetime_consumed_usdc: 0, accounts: 0 };
  return \`
    <div class="stat-row"><span>Purchased 30d (crypto)</span><span class="stat-val accent">\${fmtUsd(c.purchased_30d.crypto.total_usdc)} <span style="color:var(--muted)">(\${c.purchased_30d.crypto.count})</span></span></div>
    <div class="stat-row"><span>Purchased 30d (fiat)</span><span class="stat-val accent">\${fmtUsd(c.purchased_30d.fiat.total_usdc)} <span style="color:var(--muted)">(\${c.purchased_30d.fiat.count})</span></span></div>
    <div class="stat-row"><span>Lifetime purchased / consumed</span><span class="stat-val">\${fmtUsd(c.lifetime_purchased_usdc)} / \${fmtUsd(c.lifetime_consumed_usdc)}</span></div>
    <div class="stat-row"><span>Outstanding (liability)</span><span class="stat-val yellow">\${fmtUsd(c.outstanding_usdc)} <span style="color:var(--muted)">in \${c.accounts} accounts</span></span></div>
  \`;
}

function tabsBar() {
  const tabs = [['overview', 'Overview'], ['logs', 'Registros']];
  const chips = tabs.map(([t, label]) =>
    \`<button class="seg-btn \${state.tab === t ? 'active' : ''}" aria-pressed="\${state.tab === t}" onclick="setTab('\${t}')">\${label}</button>\`
  ).join('');
  return \`<div class="seg-group">\${chips}</div>\`;
}

function render(d) {
  lastData = d;
  const w = windowStats(d);
  const wl = winLabel();
  const pf = w.paywall_funnel || { hit_payers: 0, converted_payers: 0 };
  const pfRate = pf.hit_payers > 0 ? Math.round((pf.converted_payers / pf.hit_payers) * 100) : 0;

  let callsPlot, revPlot, granularity, callsSum, revSum, callsDelta, revDelta;
  if (state.days === 1) {
    // Fase 24.7 — intraday: rebucket the 30' server series to the selected
    // granularity, entirely client-side (data already covers 7d in one GET).
    const bucketMs = GRANULARITY_MS[state.granularity] || GRANULARITY_MS['1h'];
    const factor = bucketMs / 1800000;
    const callsRaw = zeroFillIntraday(d.calls_by_halfhour, 'calls', 24, 1800000);
    const revRaw = zeroFillIntraday(d.revenue_by_halfhour, 'revenue', 24, 1800000);
    callsPlot = bucketIntraday(callsRaw, factor);
    revPlot = bucketIntraday(revRaw, factor);
    granularity = 'intraday';
    callsSum = sumSeries(callsRaw);
    revSum = sumSeries(revRaw);
    callsDelta = null;
    revDelta = null;
  } else {
    const callsDaily = zeroFillDaily(d.calls_by_day, 'calls', 365);
    const revDaily = zeroFillDaily(d.revenue_by_day, 'revenue', 365);
    const callsWindow = callsDaily.slice(365 - state.days);
    const revWindow = revDaily.slice(365 - state.days);
    callsPlot = state.days === 365 ? bucketWeekly(callsWindow) : callsWindow;
    revPlot = state.days === 365 ? bucketWeekly(revWindow) : revWindow;
    granularity = state.days === 365 ? 'week' : 'day';
    callsSum = sumSeries(callsWindow);
    revSum = sumSeries(revWindow);
    callsDelta = windowDelta(callsDaily, state.days);
    revDelta = windowDelta(revDaily, state.days);
  }

  const overviewHtml = \`
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Calls · \${tfLabel(state.days)}</div>
        <div class="kpi-value accent">\${fmt(callsSum, 0)}\${deltaBadge(callsDelta)}</div>
        <div class="kpi-sub">MCP tool calls</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Revenue · \${tfLabel(state.days)}</div>
        <div class="kpi-value green">\${fmtUsd(revSum)}\${deltaBadge(revDelta)}</div>
        <div class="kpi-sub">usage · USDC (excl. credit purchases)</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Unique agents · \${wl}</div>
        <div class="kpi-value">\${fmt(w.unique_payers + (w.unique_anon_agents || 0), 0)}</div>
        <div class="kpi-sub">\${fmt(w.unique_payers, 0)} identified · \${fmt(w.unique_anon_agents || 0, 0)} anon · \${fmt(d.summary.returning_agents_7d || 0, 0)} returning · 7d</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Paywall → paid · \${wl}</div>
        <div class="kpi-value yellow">\${pfRate}%</div>
        <div class="kpi-sub">\${fmt(pf.converted_payers, 0)} of \${fmt(pf.hit_payers, 0)} agents that saw a 402 paid within 7d</div>
      </div>
    </div>

    \${controlsBar()}
    \${retentionNotice(d)}

    <div class="grid2">
      <div class="card">
        <h2>Calls</h2>
        \${timeChart(callsPlot, { color: '#2f81f7', kind: 'num', granularity })}
      </div>
      <div class="card">
        <h2>Revenue (USDC)</h2>
        \${timeChart(revPlot, { color: '#3fb950', kind: 'usd', granularity })}
      </div>
    </div>

    <div class="grid3">
      <div class="card">
        <h2>Top tools · \${wl}</h2>
        <div class="bar-chart">\${barChart(w.top_tools, 'calls', 'tool', '#a371f7')}</div>
      </div>
      <div class="card">
        <h2>Payment mix · \${wl}</h2>
        \${payChips(w.payment_breakdown)}
      </div>
      <div class="card">
        <h2>Credits</h2>
        \${creditsCard(d.credits)}
      </div>
    </div>

    <div class="grid2">
      <div class="card">
        <h2>Calls by surface · \${wl}</h2>
        <div class="bar-chart">\${surfaceBars(w.calls_by_client)}</div>
      </div>
      <div class="card">
        <h2>Paywall → conversion · \${wl} (agents)</h2>
        \${paywallFunnelStat(pf, wl)}
      </div>
    </div>

    <div class="grid-wide">
      <div class="card">
        <h2>Tool errors · \${wl} <span style="color:var(--muted);font-weight:400">(red = paged, amber = upstream, grey = caller)</span></h2>
        \${errorRateChart(w.error_rate_by_tool)}
      </div>
      <div class="card">
        <h2>Latency by tool · \${wl}</h2>
        \${latencyByToolTable(w.latency_by_tool)}
        <div class="stat-row" style="margin-top:8px"><span>Global avg / p50 / p95</span><span class="stat-val">\${w.avg_latency_ms} / \${w.p50_latency_ms} / \${w.p95_latency_ms} ms</span></div>
      </div>
    </div>
  \`;

  const logsHtml = \`
    <div class="grid-wide">
      <div class="card">
        <h2>Surface funnel · connects 7d, sessions 30d — connect → ≥1 call → ≥3 same family → paid</h2>
        \${surfaceFunnelTable(d.surface)}
      </div>
      <div class="card">
        <h2>Directory coverage · 7d</h2>
        \${directoryCoverageTable(d.directory_coverage)}
      </div>
    </div>

    <div class="card" style="margin-bottom:24px">
      <h2>Directory listings</h2>
      \${directoryStatsTable(d.directory_stats, d.smithery_use_count_series)}
    </div>

    <div class="card" style="margin-bottom:24px">
      <h2>Recent failures · 30d <span style="color:var(--muted);font-weight:400">(402 handshakes excluded)</span></h2>
      \${errorTable(d.recent_errors)}
    </div>

    <div class="card" style="margin-bottom:24px">
      <h2>Credit purchases · 365d</h2>
      \${creditPurchasesTable(d.credit_purchases)}
    </div>
  \`;

  const html = \`
    \${healthStrip(d.health)}
    <div style="margin-bottom:16px">\${tabsBar()}</div>
    \${state.tab === 'overview' ? overviewHtml : logsHtml}
  \`;
  document.getElementById('root').innerHTML = html;
}

// Fase 25.17 — load(true) (el boton ↻) pide ?fresh=1 y salta la cache de 5 min
// del servidor; la carga inicial, el toggle de internos y el refresco al volver
// a la pestana usan la cache.
async function load(force) {
  document.getElementById('last-updated').textContent = 'loading…';
  const refreshBtn = document.querySelector('.refresh-btn');
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const query = [];
    if (state.internal) query.push('include_internal=1');
    if (force === true) query.push('fresh=1');
    const res = await fetch('/analytics/data' + (query.length ? '?' + query.join('&') : ''));
    if (!res.ok) {
      const msg = res.status === 401 ? 'Sesión de Cloudflare Access caducada: recarga la página para volver a entrar.'
        : res.status === 502 ? 'D1 no responde (error del servidor). Reintenta en un minuto.'
        : 'Error HTTP ' + res.status + ' al cargar los datos.';
      const box = document.createElement('div');
      box.className = 'error';
      box.textContent = msg;
      const root = document.getElementById('root');
      root.innerHTML = '';
      root.appendChild(box);
      return;
    }
    const data = await res.json();
    render(data);
    document.getElementById('last-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('root').innerHTML = \`<div class="error">\${e.message}</div>\`;
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

load();

// Fase 25.8 — aqui estaba un setInterval(load, 60_000), sin mirar siquiera si
// la pestana estaba visible. Cada carga son ~25 consultas sobre
// analytics_events (~100k filas leidas), asi que un refresco por minuto son
// ~6M filas/hora: mas que el limite DIARIO del free tier de D1 (5M) en una
// sola hora, y se pagaba igual con la pestana olvidada en segundo plano.
//
// No hay intervalo. Este panel mide un servidor con ~150 llamadas al dia: no
// hay ningun dato que se pierda por no refrescar solo, y el boton ↻ da el
// dato fresco al instante cuando de verdad hace falta. Lo unico automatico
// que queda es refrescar al VOLVER a la pestana, y solo si lo que se ve tiene
// mas de 15 minutos — acotado a 4 cargas/hora como mucho, y solo mientras
// alguien esta mirando de verdad.
var STALE_MS = 15 * 60 * 1000;
var lastLoad = Date.now();
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastLoad < STALE_MS) return;
  lastLoad = Date.now();
  load();
});
</script>
</body>
</html>`;
