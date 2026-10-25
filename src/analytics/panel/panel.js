// Fase 25.18 — app del panel /analytics (DOM). Las funciones puras viven en
// panel-lib.js; panel.ts concatena ambos ficheros en un script inline (type module)
// y retira esta linea de import al ensamblar (test/analytics-panel.ts lo comprueba).
import {
  PAGE_SIZES, fmt, fmtUsd, fmtPct, fmtMs, esc, timeLabel, truncatePayer, tfLabel, winKey, winLabel,
  seriesForTimeframe, smitheryDelta, niceMax, formatXLabel, formatFullDate, paginate, paywallRate,
  groupSurface, cogsSummary, partialLabel, funnelRows, healthSummary, retentionParts, sanitizeState, classifyDataResponse,
} from './panel-lib.js';

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const LS_KEY = 'ts_panel';
// Fase 25.20 — marca de una recarga pedida por el boton refresh con la sesion
// de Access caducada: al volver, la primera carga salta la cache del servidor.
const RELOAD_FRESH_KEY = 'ts_panel_reload_fresh';
// true mientras esta carga venga de esa recarga: si Access sigue sin sesion, no
// se recarga otra vez (evita un bucle si el login de Access no se completa).
let reloadedForSession = false;
const DEFAULTS = {
  days: 30,
  view: 'line',
  internal: false,
  tab: 'overview',
  granularity: '1h',
  pagers: { funnel: { page: 0, size: 15 }, errors: { page: 0, size: 15 }, purchases: { page: 0, size: 15 } },
};
let state = DEFAULTS;
try { state = sanitizeState(JSON.parse(localStorage.getItem(LS_KEY) || '{}'), DEFAULTS); } catch (e) { state = sanitizeState(null, DEFAULTS); }
let lastData = null;
let lastLoad = Date.now();
const STALE_MS = 15 * 60 * 1000;

function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
}

// Color por entidad (nunca por posicion): el mismo tipo de pago lleva siempre el mismo swatch.
const PAY_SLOT = {
  x402_paid: 's1', prepaid: 's2', api_key: 's3', oauth: 's4', x402_free_first: 's5',
  free_tool: 'grey', '402_no_wallet': 'grey-2',
  '402_pay_failed': 'danger', settle_failed: 'danger', tool_error: 'danger', deposit_failed: 'danger', fiat_deposit_failed: 'danger',
  prepaid_insufficient: 'warn', prepaid_rejected: 'warn', api_key_rejected: 'warn', api_key_insufficient: 'warn', oauth_insufficient: 'warn',
  deposit_success: 's2', fiat_deposit_success: 's1', fiat_webhook_ignored: 'grey',
};
const CLASS_SLOT = { paged: 'danger', upstream: 'warn', caller: 'grey', muted: 'grey-2', payment: 'warn', money: 'danger' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Paneles: un contenedor por tarjeta, con estado propio
// ---------------------------------------------------------------------------
function panelEl(name) { return $('[data-panel="' + name + '"]'); }

function setPanel(name, html, state = 'ready') {
  const el = panelEl(name);
  if (!el) return;
  const body = $('.panel-body', el);
  body.innerHTML = html;
  el.dataset.state = state;
  applyWidths(body);
}
function setEmpty(name, text) { setPanel(name, '<p class="state">' + esc(text) + '</p>', 'empty'); }
function setError(name, message) {
  setPanel(name, '<p class="state state-error"><span class="mark danger"></span><span>' + esc(message) + '</span></p>', 'error');
}
/** Aviso de arriba del panel. `signIn` anade el boton que vuelve a entrar por Access. */
function showNotice(level, text, signIn) {
  const notice = $('#notice');
  notice.innerHTML = '<span class="mark ' + (level === 'info' ? 'muted' : 'danger') + '"></span><span>' + esc(text) + '</span>'
    + (signIn ? '<button type="button" class="btn" data-signin="1">sign in again</button>' : '');
  notice.hidden = false;
}
/** Sin datos previos: cada tarjeta dice que no tiene datos; el detalle va en el aviso de arriba. */
function markNotLoaded() {
  $$('[data-panel]').forEach((p) => setError(p.dataset.panel, 'not loaded'));
  $$('[data-kpi]').forEach((k) => { k.dataset.state = 'error'; $('.num', k).textContent = '–'; });
}
/** Recarga la pagina: la navegacion pasa por el login de Access y vuelve aqui. */
function signInAgain(fresh) {
  if (fresh) { try { sessionStorage.setItem(RELOAD_FRESH_KEY, '1'); } catch (e) { /* private mode */ } }
  location.reload();
}
/** Anchos de barras desde data-w: el markup no lleva estilos inline, los aplica el DOM. */
function applyWidths(root) {
  $$('[data-w]', root).forEach((el) => { el.style.flex = '0 1 ' + el.dataset.w + '%'; });
}
function setWin(label) {
  $$('.win').forEach((el) => { if (!el.closest('[data-panel="directory"], [data-panel="failures"], [data-panel="purchases"]')) el.textContent = label; });
}

// ---------------------------------------------------------------------------
// Fragmentos
// ---------------------------------------------------------------------------
function legend(items) {
  return '<div class="legend" aria-label="Legend">' + items.map((it) =>
    '<span class="legend-item"><span class="key ' + it.slot + '"></span>' + esc(it.label) + (it.n !== undefined ? ' <span class="n">' + esc(it.n) + '</span>' : '') + '</span>'
  ).join('') + '</div>';
}

/** Barras horizontales apiladas: rows = [{label, title?, segs:[{slot, value, title}], valueHtml, max?}]; `max` global o por fila. */
function hBars(rows, max) {
  return '<div class="bars">' + rows.map((r) => {
    const rowMax = r.max || max;
    const segs = r.segs.filter((s) => s.value > 0).map((s) =>
      '<span class="bar-seg ' + s.slot + '" data-w="' + ((s.value / rowMax) * 100).toFixed(2) + '" title="' + esc(s.title) + '"></span>'
    ).join('');
    return '<div class="bar-row"><span class="bar-label" title="' + esc(r.title || r.label) + '">' + esc(r.label) + '</span>'
      + '<span class="bar-track" role="img" aria-label="' + esc(r.aria || '') + '">' + segs + '</span>'
      + '<span class="bar-val">' + r.valueHtml + '</span></div>';
  }).join('') + '</div>';
}

function pager(key, total) {
  const p = state.pagers[key];
  if (total <= PAGE_SIZES[0]) return ''; // cabe en una pagina con cualquier tamano: no hay nada que paginar
  const maxPage = Math.max(0, Math.ceil(total / p.size) - 1);
  const page = Math.min(p.page, maxPage);
  const start = page * p.size + 1, end = Math.min(total, start + p.size - 1);
  return '<nav class="pager" aria-label="Pagination" data-pager="' + key + '">'
    + '<button type="button" class="btn" data-page="-1"' + (page === 0 ? ' disabled' : '') + ' aria-label="Previous page"><svg aria-hidden="true"><use href="#i-prev"/></svg></button>'
    + '<span class="info">' + start + '–' + end + ' of ' + total + '</span>'
    + '<button type="button" class="btn" data-page="1"' + (page >= maxPage ? ' disabled' : '') + ' aria-label="Next page"><svg aria-hidden="true"><use href="#i-next"/></svg></button>'
    + '<span class="seg sizes" role="group" aria-label="Rows per page">' + PAGE_SIZES.map((n) =>
      '<button type="button" data-size="' + n + '" aria-pressed="' + (p.size === n) + '">' + n + '</button>').join('') + '</span>'
    + '</nav>';
}

function table(cols, rowsHtml) {
  return '<div class="table-scroll"><table class="tbl"><thead><tr>'
    + cols.map((c) => '<th scope="col"' + (c.num ? ' class="num"' : '') + '>' + esc(c.label) + '</th>').join('')
    + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}

function deltaHtml(delta) {
  if (!delta) return '';
  const sign = delta.up ? '+' : '−';
  return '<span class="sr">' + (delta.up ? 'up' : 'down') + ' </span>' + sign + Math.abs(delta.pct) + '%';
}

// ---------------------------------------------------------------------------
// Chart temporal (SVG propio, ancho medido para que el texto no escale)
// ---------------------------------------------------------------------------
function timeChart(series, opts) {
  const fmtV = opts.kind === 'usd' ? fmtUsd : (v) => fmt(v, 0);
  if (!series || series.length === 0 || series.every((s) => s.value === 0)) {
    return '<p class="state">no activity in this period</p>';
  }
  const W = Math.max(260, opts.width || 560), H = 210, ML = 48, MR = 14, MT = 14, MB = 26;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const n = series.length;
  // Fase 25.21: el ultimo punto puede ser el dia UTC en curso (parcial). El "ultimo valor"
  // anotado es el del ultimo punto completo; el parcial se dibuja aparte, a su derecha.
  const hasPartial = !!series[n - 1].partial;
  const lastIdx = hasPartial ? n - 2 : n - 1;
  const maxVal = Math.max(...series.map((s) => s.value));
  const top = niceMax(maxVal);
  const xAt = (i) => (n === 1 ? ML + plotW / 2 : ML + (i / (n - 1)) * plotW);
  const yAt = (v) => MT + plotH - (v / top) * plotH;
  const r2 = (v) => Math.round(v * 100) / 100;

  // Ticks redondos: 5 pasos (10/20/50/100 -> 2/4/10/20), 4 cuando el tope es 2·10^k;
  // con pocas llamadas, un tick por entero.
  const norm = top / Math.pow(10, Math.floor(Math.log10(top)));
  const steps = opts.kind !== 'usd' && top < 5 ? top : norm === 2 ? 4 : 5;
  let grid = '';
  for (let g = 0; g <= steps; g++) {
    const v = (top * g) / steps, y = r2(yAt(v));
    grid += '<line class="' + (g === 0 ? 'base-line' : 'grid-line') + '" x1="' + ML + '" y1="' + y + '" x2="' + (W - MR) + '" y2="' + y + '"/>';
    grid += '<text x="' + (ML - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + esc(fmtV(v)) + '</text>';
  }
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(plotW / 90))));
  let xLabels = '';
  for (let i = 0; i < n; i++) {
    if (i !== n - 1 && i % every !== 0) continue;
    if (i !== n - 1 && n - 1 - i < every / 2) continue; // no pisar la ultima etiqueta
    xLabels += '<text x="' + r2(xAt(i)) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(formatXLabel(series[i].day, opts.granularity)) + '</text>';
  }

  let viz = '';
  const slot = opts.slot;
  if (opts.view === 'bar') {
    const band = n === 1 ? plotW : plotW / (n - 1);
    const bw = Math.min(24, Math.max(2, band - 2));
    viz = series.map((s, i) => {
      const y = yAt(s.value), h = Math.max(MT + plotH - y, 0);
      if (h <= 0) return '';
      const x = xAt(i) - bw / 2, rr = Math.min(4, bw / 2, h);
      // esquinas redondeadas solo arriba (extremo del dato); base recta
      const d = 'M' + r2(x) + ' ' + r2(MT + plotH) + 'V' + r2(y + rr) + 'Q' + r2(x) + ' ' + r2(y) + ' ' + r2(x + rr) + ' ' + r2(y) + 'H' + r2(x + bw - rr) + 'Q' + r2(x + bw) + ' ' + r2(y) + ' ' + r2(x + bw) + ' ' + r2(y + rr) + 'V' + r2(MT + plotH) + 'Z';
      return '<path class="bar-mark ' + slot + (s.partial ? ' partial' : '') + '" data-i="' + i + '" d="' + d + '"/>';
    }).join('');
  } else {
    const full = series.slice(0, lastIdx + 1);
    const pts = full.map((s, i) => r2(xAt(i)) + ',' + r2(yAt(s.value))).join(' ');
    if (lastIdx >= 0) {
      const area = r2(xAt(0)) + ',' + (MT + plotH) + ' ' + pts + ' ' + r2(xAt(lastIdx)) + ',' + (MT + plotH);
      const lastX = r2(xAt(lastIdx)), lastY = r2(yAt(series[lastIdx].value));
      viz = '<polygon class="area ' + slot + '" points="' + area + '"/>'
        + '<polyline class="line ' + slot + '" points="' + pts + '"/>'
        + '<circle class="end-dot ' + slot + '" cx="' + lastX + '" cy="' + lastY + '" r="4"/>'
        + '<text class="end-label" x="' + lastX + '" y="' + (lastY - 10) + '" text-anchor="' + (lastIdx > 0 ? 'end' : 'middle') + '">' + esc(fmtV(series[lastIdx].value)) + '</text>';
    }
    if (hasPartial) {
      const px = r2(xAt(n - 1)), py = r2(yAt(series[n - 1].value));
      if (lastIdx >= 0) viz += '<line class="line-partial ' + slot + '" x1="' + r2(xAt(lastIdx)) + '" y1="' + r2(yAt(series[lastIdx].value)) + '" x2="' + px + '" y2="' + py + '"/>'
        ;
      viz += '<circle class="partial-dot ' + slot + '" cx="' + px + '" cy="' + py + '" r="4"/>';
    }
  }

  const data = esc(JSON.stringify({ s: series.map((s) => (s.partial ? [s.day, s.value, 1] : [s.day, s.value])), k: opts.kind, g: opts.granularity, W, H, ML, MR, MT, MB, view: opts.view }));
  return '<figure class="chart" aria-label="' + esc(opts.label) + '">'
    + '<div class="chart-hit" tabindex="0" role="img" aria-label="' + esc(opts.label + ', ' + n + ' points, latest ' + (hasPartial && lastIdx >= 0 ? fmtV(series[lastIdx].value) + ' complete, ' + fmtV(series[n - 1].value) + ' so far today' : fmtV(series[n - 1].value))) + '" data-chart="' + data + '">'
    + '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">'
    + grid + viz + xLabels
    + '<line class="guide" x1="0" y1="' + MT + '" x2="0" y2="' + (MT + plotH) + '" visibility="hidden"/>'
    + '<circle class="hover-dot ' + slot + '" r="4" visibility="hidden"/>'
    + '</svg></div><div class="tip" role="tooltip" hidden></div></figure>';
}

function chartPoint(hit, idx) {
  const c = JSON.parse(hit.dataset.chart);
  const n = c.s.length;
  const i = Math.max(0, Math.min(n - 1, idx));
  const plotW = c.W - c.ML - c.MR, plotH = c.H - c.MT - c.MB;
  const top = niceMax(Math.max(...c.s.map((p) => p[1])));
  const x = n === 1 ? c.ML + plotW / 2 : c.ML + (i / (n - 1)) * plotW;
  const y = c.MT + plotH - (c.s[i][1] / top) * plotH;
  const svg = $('svg', hit);
  const guide = $('.guide', svg), dot = $('.hover-dot', svg);
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.removeAttribute('visibility');
  if (c.view === 'bar') { dot.setAttribute('visibility', 'hidden'); } else { dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.removeAttribute('visibility'); }
  $$('.bar-mark', svg).forEach((b) => b.classList.toggle('lit', Number(b.dataset.i) === i));
  const tip = $('.tip', hit.parentElement);
  const fmtV = c.k === 'usd' ? fmtUsd : (v) => fmt(v, 0);
  tip.textContent = '';
  const v = document.createElement('div'); v.className = 'tip-v'; v.textContent = fmtV(c.s[i][1]) + (c.k === 'usd' ? '' : ' calls');
  const d = document.createElement('div'); d.className = 'tip-d'; d.textContent = formatFullDate(c.s[i][0], c.g);
  tip.append(v, d);
  const pl = partialLabel({ partial: c.s[i][2] === 1 }, c.g);
  if (pl) { const p = document.createElement('div'); p.className = 'tip-p'; p.textContent = pl; tip.append(p); }
  tip.hidden = false;
  const leftPct = (x / c.W) * 100;
  tip.style.left = leftPct + '%';
  tip.style.transform = leftPct > 62 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)';
  hit.dataset.idx = String(i);
  return { n, i };
}
function chartLeave(hit) {
  const svg = $('svg', hit);
  $('.guide', svg).setAttribute('visibility', 'hidden');
  $('.hover-dot', svg).setAttribute('visibility', 'hidden');
  $$('.bar-mark.lit', svg).forEach((b) => b.classList.remove('lit'));
  const tip = $('.tip', hit.parentElement);
  if (tip) tip.hidden = true;
}
document.addEventListener('pointermove', (ev) => {
  const hit = ev.target.closest && ev.target.closest('.chart-hit');
  if (!hit) return;
  const c = JSON.parse(hit.dataset.chart);
  const rect = hit.getBoundingClientRect();
  const xUser = ((ev.clientX - rect.left) / rect.width) * c.W;
  const plotW = c.W - c.ML - c.MR, n = c.s.length;
  chartPoint(hit, n === 1 ? 0 : Math.round(((xUser - c.ML) / plotW) * (n - 1)));
});
document.addEventListener('pointerout', (ev) => {
  const hit = ev.target.closest && ev.target.closest('.chart-hit');
  if (hit && !(ev.relatedTarget && hit.contains(ev.relatedTarget))) chartLeave(hit);
});
document.addEventListener('focusin', (ev) => {
  const hit = ev.target.closest && ev.target.closest('.chart-hit');
  if (hit) chartPoint(hit, JSON.parse(hit.dataset.chart).s.length - 1);
});
document.addEventListener('focusout', (ev) => {
  const hit = ev.target.closest && ev.target.closest('.chart-hit');
  if (hit) chartLeave(hit);
});
document.addEventListener('keydown', (ev) => {
  const hit = ev.target.closest && ev.target.closest('.chart-hit');
  if (!hit || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End')) return;
  ev.preventDefault();
  const n = JSON.parse(hit.dataset.chart).s.length;
  const cur = Number(hit.dataset.idx ?? n - 1);
  const next = ev.key === 'ArrowLeft' ? cur - 1 : ev.key === 'ArrowRight' ? cur + 1 : ev.key === 'Home' ? 0 : n - 1;
  chartPoint(hit, next);
});

// ---------------------------------------------------------------------------
// Render por tarjeta
// ---------------------------------------------------------------------------
function chartWidth(name) {
  const el = panelEl(name);
  return el ? $('.panel-body', el).clientWidth : 560;
}

function renderCharts(d) {
  const s = seriesForTimeframe(d, state.days, state.granularity);
  setPanel('calls-chart', timeChart(s.calls, { slot: 's1', kind: 'num', granularity: s.granularity, view: state.view, width: chartWidth('calls-chart'), label: 'Calls over time' }));
  setPanel('revenue-chart', timeChart(s.revenue, { slot: 's3', kind: 'usd', granularity: s.granularity, view: state.view, width: chartWidth('revenue-chart'), label: 'Revenue over time, USDC' }));
  return s;
}

function renderKpis(d, w, s) {
  const tf = tfLabel(state.days), wl = winLabel(state.days);
  const kpi = (name, value, delta, sub, label) => {
    const el = $('[data-kpi="' + name + '"]');
    $('.num', el).textContent = value;
    $('.delta', el).innerHTML = deltaHtml(delta);
    // Fase 25.21: el delta compara dias completos (sin hoy); la cifra grande si suma hoy.
    if (delta && delta.through) $('.delta', el).title = 'Last ' + state.days + ' full days to ' + formatFullDate(delta.through, 'day') + ' vs the ' + state.days + ' before. Today is left out until it ends.';
    else $('.delta', el).removeAttribute('title');
    $('.delta', el).className = 'delta' + (delta ? (delta.up ? ' up' : ' down') : '');
    $('.win', el).textContent = label;
    if (sub !== undefined) $('.kpi-sub', el).textContent = sub;
    el.dataset.state = 'ready';
  };
  kpi('calls', fmt(s.callsSum, 0), s.callsDelta, 'MCP tool calls' + (s.callsDelta ? ' · change on full days, today left out' : ''), tf);
  kpi('revenue', fmtUsd(s.revenueSum), s.revenueDelta, 'usage, USDC (credit purchases excluded)' + (s.revenueDelta ? ' · change on full days' : ''), tf);
  const anon = w.unique_anon_agents || 0;
  kpi('agents', fmt(w.unique_payers + anon, 0), null,
    fmt(w.unique_payers, 0) + ' identified · ' + fmt(anon, 0) + ' anonymous · ' + fmt(d.summary.returning_agents_7d || 0, 0) + ' returning in 7d', wl);
  const pf = w.paywall_funnel || { hit_payers: 0, converted_payers: 0 };
  const rate = paywallRate(pf);
  kpi('paywall', rate === null ? '–' : rate + '%', null,
    rate === null ? 'no agent hit a 402 in ' + wl : fmt(pf.converted_payers, 0) + ' of ' + fmt(pf.hit_payers, 0) + ' agents that saw a 402 paid within 7d', wl);
}

function renderTopTools(w) {
  const items = w.top_tools || [];
  if (items.length === 0) return setEmpty('top-tools', 'no tool calls yet');
  const max = Math.max(...items.map((i) => i.calls), 1);
  setPanel('top-tools', hBars(items.map((it) => ({
    label: it.tool, aria: it.tool + ': ' + it.calls + ' calls',
    segs: [{ slot: 's1', value: it.calls, title: it.tool + ': ' + it.calls }],
    valueHtml: fmt(it.calls, 0),
  })), max));
}

function renderPaymentMix(w) {
  const items = (w.payment_breakdown || []).slice().sort((a, b) => b.calls - a.calls);
  if (items.length === 0) return setEmpty('payment-mix', 'no calls yet');
  const total = items.reduce((s, b) => s + (b.calls || 0), 0);
  const track = '<div class="mix-track" role="img" aria-label="Share of calls by payment outcome">' + items.map((b) =>
    '<span class="mix-seg bar-seg ' + (PAY_SLOT[b.type] || 'grey') + '" data-w="' + ((b.calls / total) * 100).toFixed(2) + '" data-type="' + esc(b.type) + '" title="' + esc(b.type + ': ' + b.calls) + '"></span>'
  ).join('') + '</div>';
  const list = '<div class="mix-list">' + items.map((b) =>
    '<div class="mix-row" data-type="' + esc(b.type) + '"><span class="key ' + (PAY_SLOT[b.type] || 'grey') + '"></span><span class="name" title="' + esc(b.type) + '">' + esc(b.type) + '</span><span class="n">' + fmt(b.calls, 0) + '</span><span class="pct">' + fmtPct(b.calls, total) + '</span></div>'
  ).join('') + '</div>';
  setPanel('payment-mix', track + list);
}

function renderCredits(d, w) {
  const c = d.credits;
  if (!c) return setEmpty('credits', 'no balances yet');
  const p = c.purchased_30d || { crypto: { count: 0, total_usdc: 0 }, fiat: { count: 0, total_usdc: 0 } };
  const row = (k, v, dim) => '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + v + (dim ? ' <span class="dim">' + esc(dim) + '</span>' : '') + '</span></div>';
  let html = '<div class="rows">'
    + row('Purchased 30d, crypto', fmtUsd(p.crypto.total_usdc), p.crypto.count + (p.crypto.count === 1 ? ' purchase' : ' purchases'))
    + row('Purchased 30d, fiat', fmtUsd(p.fiat.total_usdc), p.fiat.count + (p.fiat.count === 1 ? ' purchase' : ' purchases'))
    + row('Lifetime purchased / consumed', fmtUsd(c.lifetime_purchased_usdc) + ' <span class="dim">/</span> ' + fmtUsd(c.lifetime_consumed_usdc))
    + row('Outstanding liability', fmtUsd(c.outstanding_usdc), 'in ' + c.accounts + (c.accounts === 1 ? ' account' : ' accounts'));
  const cg = cogsSummary(w);
  if (cg) {
    const wl = winLabel(state.days);
    html += '<div class="row total"><span class="k">Estimated COGS ' + wl + '</span><span class="v">' + fmtUsd(cg.total) + '</span></div>'
      + row('Margin ' + wl + ' (revenue − COGS)', fmtUsd(cg.margin), cg.marginPct === null ? '' : cg.marginPct + '%')
      + '</div><p class="rows-sub">' + cg.rows.map((r) => '<span class="mono">' + esc(r.tool) + '</span> ' + fmt(r.calls, 0) + ' × ' + fmtUsd(r.cogs_usdc / r.calls) + ' = ' + fmtUsd(r.cogs_usdc)).join(' · ') + '</p>';
  } else {
    html += '</div>';
  }
  setPanel('credits', html);
}

function renderSurface(w) {
  const rows = groupSurface(w.calls_by_client);
  if (rows.length === 0) return setEmpty('surface', 'no calls by surface yet');
  const max = Math.max(...rows.map((r) => r.real + r.scanner), 1);
  const bars = hBars(rows.map((r) => ({
    label: r.client, aria: r.client + ': ' + r.real + ' real calls, ' + r.scanner + ' from scanners',
    segs: [{ slot: 's1', value: r.real, title: 'real calls: ' + r.real }, { slot: 'grey-2', value: r.scanner, title: 'scanners and directory probes: ' + r.scanner }],
    valueHtml: fmt(r.real, 0) + (r.scanner > 0 ? ' <span class="dim">+' + fmt(r.scanner, 0) + '</span>' : ''),
  })), max);
  setPanel('surface', legend([{ slot: 's1', label: 'real calls' }, { slot: 'grey-2', label: 'scanners and directory probes' }]) + bars);
}

function renderPaywall(w) {
  const pf = w.paywall_funnel;
  const wl = winLabel(state.days);
  if (!pf || pf.hit_payers === 0) return setEmpty('paywall', 'no paywall hits in ' + wl);
  const rate = paywallRate(pf);
  setPanel('paywall', '<div class="rows">'
    + '<div class="row"><span class="k">Agents that hit the paywall</span><span class="v">' + fmt(pf.hit_payers, 0) + '</span></div>'
    + '<div class="row"><span class="k">Converted within 7d</span><span class="v">' + fmt(pf.converted_payers, 0) + '</span></div>'
    + '<div class="row total"><span class="k">Conversion rate</span><span class="v">' + rate + '%</span></div>'
    + '</div>');
}

function renderErrors(w) {
  const items = w.error_rate_by_tool || [];
  if (items.length === 0) return setEmpty('errors', 'no tool errors in this window');
  // Cada barra es el 100 % de las llamadas de SU tool: lo que se lee es la tasa de fallo por clase.
  const bars = hBars(items.map((it) => {
    const caller = it.caller_errors || 0, muted = it.muted_errors || 0;
    return {
      label: it.tool, aria: it.tool + ': ' + it.errors + ' of ' + it.total + ' calls failed', max: Math.max(it.total, 1),
      segs: [
        { slot: 'danger', value: it.our_errors, title: 'paged (our error): ' + it.our_errors },
        { slot: 'warn', value: it.upstream_errors, title: 'upstream site failed: ' + it.upstream_errors },
        { slot: 'grey', value: caller, title: 'caller error: ' + caller },
        { slot: 'grey-2', value: muted, title: 'internal, not paged (probe or admin): ' + muted },
      ],
      valueHtml: fmt(it.errors, 0) + ' <span class="dim">/ ' + fmt(it.total, 0) + '</span>',
    };
  }), 1);
  setPanel('errors', legend([
    { slot: 'danger', label: 'paged' }, { slot: 'warn', label: 'upstream' }, { slot: 'grey', label: 'caller' }, { slot: 'grey-2', label: 'muted' },
  ]) + bars);
}

function renderLatency(w) {
  const items = w.latency_by_tool || [];
  if (items.length === 0) return setEmpty('latency', 'no latency data in this window');
  const rows = items.map((r) => '<tr><td class="mono">' + esc(r.tool) + '</td><td class="num">' + fmt(r.calls, 0) + '</td><td class="num">' + fmtMs(r.p50_latency_ms) + '</td><td class="num">' + fmtMs(r.p95_latency_ms) + '</td></tr>').join('');
  setPanel('latency', table([{ label: 'Tool' }, { label: 'Calls', num: true }, { label: 'p50', num: true }, { label: 'p95', num: true }], rows)
    + '<div class="rows"><div class="row total"><span class="k">All tools · avg / p50 / p95</span><span class="v">' + fmtMs(w.avg_latency_ms) + ' <span class="dim">/</span> ' + fmtMs(w.p50_latency_ms) + ' <span class="dim">/</span> ' + fmtMs(w.p95_latency_ms) + '</span></div></div>');
}

function renderFunnel(d) {
  const all = funnelRows(d.surface);
  if (all.length === 0) return setEmpty('funnel', 'no connections yet');
  const pg = paginate(all, state.pagers.funnel.page, state.pagers.funnel.size);
  state.pagers.funnel.page = pg.page;
  const cell = (n, den) => fmt(n, 0) + ' <span class="dim">' + fmtPct(n, den) + '</span>';
  const rows = pg.pageItems.map((f) => '<tr><td class="mono">' + esc(f.client) + '</td><td class="num">' + fmt(f.connects, 0) + '</td><td class="num">' + cell(f.sessions_with_call, f.sessions) + '</td><td class="num">' + cell(f.sessions_family_complete, f.sessions) + '</td><td class="num">' + cell(f.sessions_paid, f.sessions) + '</td><td class="num">' + fmtUsd(f.revenue) + '</td></tr>').join('');
  setPanel('funnel', table([{ label: 'Surface' }, { label: 'Connects 7d', num: true }, { label: '≥1 call', num: true }, { label: '≥3 same family', num: true }, { label: 'Paid', num: true }, { label: 'Revenue', num: true }], rows) + pager('funnel', pg.total));
}

function renderDirectory(d) {
  const items = d.directory_coverage || [];
  if (items.length === 0) return setEmpty('directory', 'no scanner traffic in 7d');
  const rows = items.map((r) => '<tr><td class="mono">' + esc(r.client) + '</td><td class="num">' + fmt(r.hits, 0) + '</td><td class="mono dim">' + timeLabel(r.last_seen) + '</td></tr>').join('');
  setPanel('directory', table([{ label: 'Directory' }, { label: 'Connects 7d', num: true }, { label: 'Last seen (UTC)' }], rows));
}

function renderListings(d) {
  const stats = d.directory_stats || [];
  if (stats.length === 0) return setEmpty('listings', 'no directory snapshots yet');
  const delta = smitheryDelta(d.smithery_use_count_series);
  const rows = stats.map((r) => {
    const dl = r.source === 'smithery' && delta ? ' <span class="delta ' + (delta.up ? 'up' : 'down') + '">' + deltaHtml(delta) + '</span>' : '';
    return '<tr><td class="mono">' + esc(r.source) + '</td><td class="num">' + (r.use_count !== null && r.use_count !== undefined ? fmt(r.use_count, 0) + dl : '<span class="dim">listed</span>') + '</td><td class="mono dim">' + timeLabel(r.ts) + '</td></tr>';
  }).join('');
  setPanel('listings', table([{ label: 'Source' }, { label: 'useCount · 7d change', num: true }, { label: 'Last snapshot (UTC)' }], rows));
}

function renderFailures(d) {
  const items = d.recent_errors || [];
  if (items.length === 0) return setEmpty('failures', 'no failures logged in 30d');
  const pg = paginate(items, state.pagers.errors.page, state.pagers.errors.size);
  state.pagers.errors.page = pg.page;
  const rows = pg.pageItems.map((e) => {
    const cls = e.paged ? 'paged' : e.class === 'internal' ? 'muted' : e.class;
    const label = e.paged ? 'paged' : e.class === 'internal' ? 'internal · muted' : e.class;
    return '<tr><td class="mono dim">' + timeLabel(e.ts) + '</td><td class="mono">' + esc(e.tool) + '</td>'
      + '<td><span class="cell-mark" title="' + esc(e.type) + '"><span class="mark ' + (CLASS_SLOT[cls] || 'grey') + '"></span>' + esc(label) + '</span></td>'
      + '<td title="' + esc(e.client || '') + '">' + esc(e.client_name || (e.client || '').slice(0, 24) || '–') + '</td>'
      + '<td class="mono" title="' + esc(e.payer) + '">' + esc(truncatePayer(e.payer)) + '</td>'
      + '<td><span class="detail mono" title="' + esc(e.detail || '') + '">' + (esc(e.detail) || '–') + '</span></td></tr>';
  }).join('');
  setPanel('failures', table([{ label: 'Time (UTC)' }, { label: 'Tool' }, { label: 'Class' }, { label: 'Client' }, { label: 'Payer' }, { label: 'Detail' }], rows) + pager('errors', pg.total));
}

function renderPurchases(d) {
  const items = d.credit_purchases || [];
  if (items.length === 0) return setEmpty('purchases', 'no credit purchases yet');
  const pg = paginate(items, state.pagers.purchases.page, state.pagers.purchases.size);
  state.pagers.purchases.page = pg.page;
  const rows = pg.pageItems.map((p) => {
    const rail = p.type === 'fiat_deposit_success' ? 'fiat' : 'crypto';
    const replay = (p.detail || '').startsWith('replay');
    return '<tr' + (replay ? ' class="faded"' : '') + '><td class="mono dim">' + timeLabel(p.ts) + '</td>'
      + '<td><span class="cell-mark"><span class="mark ' + (rail === 'fiat' ? 's1' : 's2') + '"></span>' + rail + '</span></td>'
      + '<td class="mono" title="' + esc(p.payer) + '">' + esc(truncatePayer(p.payer)) + '</td><td class="num">' + fmtUsd(p.amount) + '</td>'
      + '<td><span class="detail mono" title="' + esc(p.detail || '') + '">' + (esc(p.detail) || '–') + '</span></td></tr>';
  }).join('');
  setPanel('purchases', table([{ label: 'Time (UTC)' }, { label: 'Rail' }, { label: 'Account' }, { label: 'Amount', num: true }, { label: 'Note' }], rows) + pager('purchases', pg.total));
}

function renderHealth(h) {
  const el = $('#health');
  const s = healthSummary(h);
  if (!s) { el.innerHTML = ''; return; }
  let html;
  if (s.ok) {
    html = '<p class="health-line" title="' + esc('last ok (5-min crons refresh hourly): ' + s.cronOk) + '"><span class="mark good"></span><span>all clear · last event ' + esc(timeLabel(s.lastEvent)) + ' UTC</span></p>';
  } else {
    html = '<ul>' + s.problems.map((p) => '<li><span class="mark danger"></span><span>' + esc(p) + '</span></li>').join('') + '</ul>';
  }
  if (s.notes.length) html += '<p class="notes">' + s.notes.map(esc).join(' · ') + '</p>';
  el.innerHTML = html;
}

function renderControls() {
  $$('[data-days]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === state.days)));
  $$('[data-granularity]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.granularity === state.granularity)));
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  $$('[data-internal]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.internal === '1') === state.internal)));
  $('#gran').hidden = state.days !== 1;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
  $('#view-overview').hidden = state.tab !== 'overview';
  $('#view-logs').hidden = state.tab !== 'logs';
}

/** Cada tarjeta se pinta por separado: un fallo en una no tumba las demas. */
function safely(name, fn) {
  try { fn(); } catch (e) { setError(name, 'could not render: ' + (e && e.message ? e.message : String(e))); }
}

function render(d) {
  lastData = d;
  const w = (d.by_window && d.by_window[winKey(state.days)]) || {
    calls: 0, revenue: 0, unique_payers: 0, unique_anon_agents: 0, avg_latency_ms: 0, p50_latency_ms: 0, p95_latency_ms: 0,
    top_tools: [], payment_breakdown: [], calls_by_client: [], paywall_funnel: { hit_payers: 0, converted_payers: 0 }, error_rate_by_tool: [], latency_by_tool: [], cogs: [],
  };
  renderControls();
  setWin(winLabel(state.days));
  const parts = retentionParts(d.retention, state.days);
  const ret = $('#retention');
  ret.textContent = parts.join(' · ');
  ret.hidden = parts.length === 0;
  safely('health', () => renderHealth(d.health));
  let s = null;
  safely('calls-chart', () => { s = renderCharts(d); });
  if (s) renderKpis(d, w, s);
  safely('top-tools', () => renderTopTools(w));
  safely('payment-mix', () => renderPaymentMix(w));
  safely('credits', () => renderCredits(d, w));
  safely('surface', () => renderSurface(w));
  safely('paywall', () => renderPaywall(w));
  safely('errors', () => renderErrors(w));
  safely('latency', () => renderLatency(w));
  safely('funnel', () => renderFunnel(d));
  safely('directory', () => renderDirectory(d));
  safely('listings', () => renderListings(d));
  safely('failures', () => renderFailures(d));
  safely('purchases', () => renderPurchases(d));
}

// ---------------------------------------------------------------------------
// Eventos (delegados)
// ---------------------------------------------------------------------------
$('#main').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn.disabled) return;
  const ds = btn.dataset;
  if (ds.signin) { signInAgain(true); return; }
  if (ds.tab) { state.tab = ds.tab; saveState(); renderControls(); if (lastData) render(lastData); return; }
  if (ds.days) { state.days = Number(ds.days); saveState(); if (lastData) render(lastData); else renderControls(); return; }
  if (ds.granularity) { state.granularity = ds.granularity; saveState(); if (lastData) render(lastData); else renderControls(); return; }
  if (ds.view) { state.view = ds.view; saveState(); if (lastData) render(lastData); else renderControls(); return; }
  if (ds.internal !== undefined) {
    const on = ds.internal === '1';
    if (state.internal === on) return;
    state.internal = on; saveState(); renderControls();
    load(); // filtro del servidor: hay que volver a pedir
    return;
  }
  const pg = btn.closest('[data-pager]');
  if (pg) {
    const key = pg.dataset.pager;
    if (ds.page) state.pagers[key].page = Math.max(0, state.pagers[key].page + Number(ds.page));
    if (ds.size) state.pagers[key] = { page: 0, size: Number(ds.size) };
    saveState();
    if (lastData) render(lastData);
  }
});
$('#refresh').addEventListener('click', () => load(true));

// Los charts se miden al pintarse: al cambiar el ancho se vuelven a pintar solos.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastData) safely('calls-chart', () => renderCharts(lastData)); }, 120);
});

// ---------------------------------------------------------------------------
// Carga. load(true) (boton refresh) pide ?fresh=1 y salta la cache de 5 min del
// servidor; la carga inicial, el toggle de internos y el refresco al volver a la
// pestana usan la cache. No hay intervalo: cada carga fria son decenas de miles
// de filas leidas en D1 (ver fase 25.8).
// ---------------------------------------------------------------------------
async function load(force) {
  const main = $('#main'), updated = $('#last-updated'), btn = $('#refresh'), notice = $('#notice');
  updated.textContent = 'loading…';
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  if (lastData) main.setAttribute('aria-busy', 'true');
  try {
    const query = [];
    if (state.internal) query.push('include_internal=1');
    if (force === true) query.push('fresh=1');
    // redirect:'manual': si Access ya no tiene sesion, su 302 a otro origen llega
    // como `opaqueredirect` en vez de reventar en un "Failed to fetch" ambiguo.
    const res = await fetch('/analytics/data' + (query.length ? '?' + query.join('&') : ''), { redirect: 'manual' });
    const contentType = res.headers.get('content-type') || '';
    let body = null;
    if (/json/i.test(contentType)) { try { body = await res.json(); } catch (e) { body = null; } }
    const verdict = classifyDataResponse({ type: res.type, status: res.status, ok: res.ok, contentType }, body);
    if (verdict.kind === 'expired') {
      if (force === true && !reloadedForSession) {
        // El usuario ha pedido datos frescos: volver a entrar por Access y cargar en fresco al volver.
        showNotice('info', verdict.message + ' · signing in again…');
        updated.textContent = 'session expired';
        signInAgain(true);
        return;
      }
      showNotice('danger', verdict.message + '.', true);
      updated.textContent = lastData ? 'session expired · showing previous data' : 'session expired';
      if (!lastData) markNotLoaded();
      return;
    }
    if (verdict.kind !== 'ok') throw new Error(verdict.message);
    const data = body;
    reloadedForSession = false;
    notice.hidden = true;
    render(data);
    lastLoad = Date.now();
    updated.textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    const raw = e && e.message ? e.message : String(e);
    // Con redirect:'manual' un TypeError aqui es red caida o CORS, no Access.
    const msg = /failed to fetch|networkerror|load failed/i.test(raw) ? 'Could not reach the server (offline?): ' + raw : raw;
    showNotice('danger', msg);
    updated.textContent = lastData ? 'showing previous data' : 'not loaded';
    if (!lastData) markNotLoaded();
  } finally {
    btn.disabled = false;
    btn.setAttribute('aria-busy', 'false');
    main.setAttribute('aria-busy', 'false');
  }
}

renderControls();
let reloadFresh = false;
try {
  reloadFresh = sessionStorage.getItem(RELOAD_FRESH_KEY) === '1';
  if (reloadFresh) sessionStorage.removeItem(RELOAD_FRESH_KEY);
} catch (e) { /* private mode */ }
reloadedForSession = reloadFresh;
load(reloadFresh);

// Refresco al VOLVER a la pestana, solo si lo que se ve tiene mas de 15 minutos.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastLoad < STALE_MS) return;
  lastLoad = Date.now();
  load();
});
