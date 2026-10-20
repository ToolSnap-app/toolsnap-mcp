// Fase 25.18 — funciones puras del panel /analytics: formato, series temporales,
// paginacion y los calculos que antes vivian dentro del template string de
// panel.ts. Sin DOM, sin estado: test/analytics-panel.ts las importa tal cual
// con tsx. panel.ts las inyecta junto con panel.js en un unico script inline (type module).

export const PAGE_SIZES = [10, 15, 25, 50];
export const TIMEFRAMES = [1, 7, 30, 90, 365];
export const GRANULARITIES = ['30m', '1h', '4h'];
export const GRANULARITY_MS = { '30m': 1800000, '1h': 3600000, '4h': 14400000 };
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

/** Numero compacto: 1,284 · 12.9k · 2 decimales por defecto para no enteros. */
export function fmt(n, decimals = 2) {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return '–';
  const v = Number(n);
  if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
  if (decimals === 0 || Number.isInteger(v)) return Math.round(v).toLocaleString('en-US');
  return v.toFixed(decimals);
}

/** USDC: $0.4718 (hasta 4 decimales, sin ceros a la derecha), $1.2k a partir de mil. */
export function fmtUsd(n) {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return '–';
  const v = Number(n);
  if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
  let s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '' || s === '-' || s === '-0') s = '0';
  return '$' + s;
}

/** Porcentaje entero o '–' cuando el denominador es 0. */
export function fmtPct(num, den) {
  if (!den) return '–';
  return Math.round((num / den) * 100) + '%';
}

export function fmtMs(ms) {
  if (ms === undefined || ms === null) return '–';
  const v = Number(ms);
  if (v >= 10000) return (v / 1000).toFixed(1) + ' s';
  return Math.round(v).toLocaleString('en-US') + ' ms';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "12:04:31 · 19 Oct" (UTC) para las tablas de registros. */
export function timeLabel(ts) {
  if (ts === undefined || ts === null) return '–';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  const iso = d.toISOString();
  return iso.slice(11, 19) + ' · ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
}

/** Direccion 0x… o acct:<uuid> recortada como error-alerts.ts truncatePayer. */
export function truncatePayer(payer) {
  const s = String(payer ?? '');
  if (s.length > 16) return s.slice(0, 10) + '…' + s.slice(-4);
  return s;
}

export function tfLabel(days) {
  return { 1: '24h', 7: '7d', 30: '30d', 90: '90d', 365: '1y' }[days] || days + 'd';
}

/** Ventana del payload que siguen las tarjetas: 90d y 1y no tienen corte propio y ensenan 30d. */
export function winKey(days) {
  return days === 1 ? 'h24' : days === 7 ? 'd7' : 'd30';
}
export function winLabel(days) {
  return days === 1 ? '24h' : days === 7 ? '7d' : '30d';
}

// ---------------------------------------------------------------------------
// Series temporales
// ---------------------------------------------------------------------------

export function zeroFillDaily(raw, valueKey, days, now = Date.now()) {
  const map = new Map((raw || []).map((r) => [r.day, r[valueKey]]));
  const d = new Date(now);
  const endUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(endUTC - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ day, value: Number(map.get(day) ?? 0) });
  }
  return out;
}

/** Semanas completas, descartando los primeros dias sueltos; `day` = primer dia de la semana. */
export function bucketWeekly(daily) {
  const rem = daily.length % 7;
  const trimmed = rem ? daily.slice(rem) : daily;
  const weeks = [];
  for (let i = 0; i < trimmed.length; i += 7) {
    const chunk = trimmed.slice(i, i + 7);
    weeks.push({ day: chunk[0].day, value: chunk.reduce((s, c) => s + c.value, 0) });
  }
  return weeks;
}

/** Medias horas del servidor (ts = inicio del bucket, ms) -> serie fija de `hours` horas acabando ahora. */
export function zeroFillIntraday(raw, valueKey, hours, bucketMs, now = Date.now()) {
  const map = new Map((raw || []).map((r) => [Number(r.ts), r[valueKey]]));
  const nowBucket = Math.floor(now / bucketMs) * bucketMs;
  const count = Math.floor((hours * 3600000) / bucketMs);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = nowBucket - i * bucketMs;
    out.push({ day: new Date(t).toISOString(), value: Number(map.get(t) ?? 0) });
  }
  return out;
}

export function bucketIntraday(series, factor) {
  if (factor <= 1) return series;
  const out = [];
  for (let i = 0; i < series.length; i += factor) {
    const chunk = series.slice(i, i + factor);
    out.push({ day: chunk[0].day, value: chunk.reduce((s, c) => s + c.value, 0) });
  }
  return out;
}

export function sumSeries(arr) {
  return arr.reduce((s, x) => s + x.value, 0);
}

/** Variacion de la ventana actual frente a la anterior del mismo tamano. null si no hay base. */
export function windowDelta(dailyArr, days) {
  const n = dailyArr.length;
  const prevStart = n - days * 2;
  if (prevStart < 0) return null;
  const curSum = sumSeries(dailyArr.slice(n - days));
  const prevSum = sumSeries(dailyArr.slice(prevStart, n - days));
  if (prevSum === 0) return null;
  return { pct: Math.round(((curSum - prevSum) / prevSum) * 100), up: curSum >= prevSum };
}

/** Delta semanal aproximado de un contador acumulado muestreado ~1/dia (Smithery useCount). */
export function smitheryDelta(series) {
  if (!series || series.length < 2) return null;
  const current = series[series.length - 1].use_count;
  const idx = Math.max(0, series.length - 8);
  if (idx === series.length - 1) return null;
  const past = series[idx].use_count;
  if (!past) return null;
  return { pct: Math.round(((current - past) / past) * 100), up: current >= past };
}

/** Lo que pinta el chart de cada timeframe: serie, granularidad, suma de la ventana y delta. */
export function seriesForTimeframe(d, days, granularity, now = Date.now()) {
  if (days === 1) {
    const bucketMs = GRANULARITY_MS[granularity] || GRANULARITY_MS['1h'];
    const factor = bucketMs / 1800000;
    const callsRaw = zeroFillIntraday(d.calls_by_halfhour, 'calls', 24, 1800000, now);
    const revRaw = zeroFillIntraday(d.revenue_by_halfhour, 'revenue', 24, 1800000, now);
    return {
      calls: bucketIntraday(callsRaw, factor),
      revenue: bucketIntraday(revRaw, factor),
      granularity: 'intraday',
      callsSum: sumSeries(callsRaw),
      revenueSum: sumSeries(revRaw),
      callsDelta: null,
      revenueDelta: null,
    };
  }
  const callsDaily = zeroFillDaily(d.calls_by_day, 'calls', 365, now);
  const revDaily = zeroFillDaily(d.revenue_by_day, 'revenue', 365, now);
  const callsWindow = callsDaily.slice(365 - days);
  const revWindow = revDaily.slice(365 - days);
  return {
    calls: days === 365 ? bucketWeekly(callsWindow) : callsWindow,
    revenue: days === 365 ? bucketWeekly(revWindow) : revWindow,
    granularity: days === 365 ? 'week' : 'day',
    callsSum: sumSeries(callsWindow),
    revenueSum: sumSeries(revWindow),
    callsDelta: windowDelta(callsDaily, days),
    revenueDelta: windowDelta(revDaily, days),
  };
}

// ---------------------------------------------------------------------------
// Ejes y etiquetas de los charts
// ---------------------------------------------------------------------------

export function niceMax(max) {
  if (!max || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  const norm = max / base;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * base;
}

export function formatXLabel(dayStr, gran) {
  if (gran === 'intraday') {
    const dt = new Date(dayStr);
    return String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0');
  }
  const dt = new Date(dayStr + 'T00:00:00Z');
  const d = dt.getUTCDate(), m = MONTHS[dt.getUTCMonth()];
  return gran === 'week' ? m : d + ' ' + m;
}

export function formatFullDate(dayStr, gran) {
  if (gran === 'intraday') {
    const dt = new Date(dayStr);
    const hh = String(dt.getUTCHours()).padStart(2, '0'), mm = String(dt.getUTCMinutes()).padStart(2, '0');
    return dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()] + ' ' + hh + ':' + mm + ' UTC';
  }
  const dt = new Date(dayStr + 'T00:00:00Z');
  const d = dt.getUTCDate(), m = MONTHS[dt.getUTCMonth()], y = dt.getUTCFullYear();
  return gran === 'week' ? 'week of ' + d + ' ' + m + ' ' + y : d + ' ' + m + ' ' + y;
}

// ---------------------------------------------------------------------------
// Paginacion (pura: el estado del pager lo guarda panel.js)
// ---------------------------------------------------------------------------

/** Recorta `items` a la pagina pedida; una pagina fuera de rango cae a la ultima. */
export function paginate(items, page, size) {
  const list = items || [];
  const total = list.length;
  const maxPage = Math.max(0, Math.ceil(total / size) - 1);
  const p = Math.min(Math.max(0, page || 0), maxPage);
  const start = p * size;
  const pageItems = list.slice(start, start + size);
  return { pageItems, total, page: p, maxPage, start: total ? start + 1 : 0, end: Math.min(total, start + size) };
}

// ---------------------------------------------------------------------------
// Calculos de tarjetas
// ---------------------------------------------------------------------------

/** KPI "Paywall -> paid": % de agentes que vieron un 402 y pagaron en 7 d; null sin hits. */
export function paywallRate(pf) {
  if (!pf || !pf.hit_payers) return null;
  return Math.round((pf.converted_payers / pf.hit_payers) * 100);
}

/** Calls by surface: una fila por cliente con tramo real y tramo escaner, de mas a menos. */
export function groupSurface(items) {
  const byClient = new Map();
  (items || []).forEach((it) => {
    const a = byClient.get(it.client) || { client: it.client, real: 0, scanner: 0 };
    if (it.probe) a.scanner += it.calls; else a.real += it.calls;
    byClient.set(it.client, a);
  });
  return Array.from(byClient.values()).sort((a, b) => b.real + b.scanner - (a.real + a.scanner));
}

/** Fila COGS / margen de Credits: null cuando ninguna tool tuvo COGS en la ventana. */
export function cogsSummary(w) {
  const rows = (w && w.cogs) || [];
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + Number(r.cogs_usdc || 0), 0);
  if (total <= 0) return null;
  const revenue = Number((w && w.revenue) || 0);
  return { rows, total, margin: revenue - total, marginPct: revenue > 0 ? Math.round(((revenue - total) / revenue) * 100) : null };
}

/** Embudo por superficie: connects reales (7 d) + sesiones (30 d) + revenue, ordenado por connects. */
export function funnelRows(surface) {
  const funnel = (surface && surface.funnel_by_client) || [];
  const connects = new Map();
  ((surface && surface.connects_by_client) || []).forEach((r) => {
    if (!r.probe) connects.set(r.client, (connects.get(r.client) || 0) + r.connects);
  });
  const revenue = new Map(((surface && surface.revenue_by_client) || []).map((r) => [r.client, r.revenue]));
  const clients = Array.from(new Set([...connects.keys(), ...funnel.map((f) => f.client)]))
    .sort((a, b) => (connects.get(b) ?? 0) - (connects.get(a) ?? 0));
  return clients.map((client) => {
    const f = funnel.find((x) => x.client === client) || { sessions: 0, sessions_with_call: 0, sessions_family_complete: 0, sessions_paid: 0 };
    return { client, connects: connects.get(client) ?? 0, revenue: revenue.get(client) ?? 0, ...f };
  });
}

const SILENCE_MS = 3 * 60 * 60 * 1000;

/** Franja de salud: lo que falla ahora (problems) y lo apagado (notes). Mismo criterio que el cron de salud. */
export function healthSummary(h, now = Date.now()) {
  if (!h) return null;
  const problems = [];
  const notes = [];
  (h.broken_tools || []).forEach((b) => {
    problems.push('tool failing for everyone: ' + b.tool + ' · ' + b.errors + '/' + b.total + ' real calls failed in 6h (' + b.pct + '%)' + (b.topDetail ? ' · ' + b.topDetail : ''));
  });
  if (h.last_event_ts == null) problems.push('no events recorded yet');
  else if (now - h.last_event_ts > SILENCE_MS) problems.push('silence: last event ' + timeLabel(h.last_event_ts));
  (h.crons || []).forEach((c) => {
    if (!c.last_error) return;
    if (c.last_ok_ts != null && c.last_error_ts != null && c.last_error_ts < c.last_ok_ts) return;
    const line = 'cron ' + c.name + ' failing: ' + c.last_error + (c.last_error_ts ? ' (' + timeLabel(c.last_error_ts) + ')' : '');
    (c.muted ? notes : problems).push(line);
  });
  const cronOk = (h.crons || []).map((c) => c.name + ': ' + (c.last_ok_ts ? timeLabel(c.last_ok_ts) : 'no mark yet')).join(' | ');
  return { ok: problems.length === 0, problems, notes, cronOk, lastEvent: h.last_event_ts };
}

/** Aviso de retencion segun el timeframe elegido; [] cuando no hace falta decir nada. */
export function retentionParts(r, days) {
  if (!r) return [];
  const parts = [];
  const surf = r.surface_days || r.connect_days;
  if (days > surf) parts.push('connects and directory coverage cover ' + surf + 'd');
  if (days > 30) {
    parts.push('per-window cards show 30d');
    if (r.oldest_event_ts) parts.push('events since ' + new Date(r.oldest_event_ts).toISOString().slice(0, 10));
    parts.push('events kept ' + r.events_days + 'd');
  }
  return parts;
}

/** Estado guardado en localStorage -> estado valido (ignora lo que no reconoce). */
export function sanitizeState(saved, defaults) {
  const s = JSON.parse(JSON.stringify(defaults));
  if (!saved || typeof saved !== 'object') return s;
  if (TIMEFRAMES.includes(saved.days)) s.days = saved.days;
  if (saved.view === 'line' || saved.view === 'bar') s.view = saved.view;
  if (saved.internal === true) s.internal = true;
  if (saved.tab === 'overview' || saved.tab === 'logs') s.tab = saved.tab;
  if (GRANULARITIES.includes(saved.granularity)) s.granularity = saved.granularity;
  if (saved.pagers && typeof saved.pagers === 'object') {
    for (const key of Object.keys(s.pagers)) {
      const size = saved.pagers[key] && saved.pagers[key].size;
      if (PAGE_SIZES.includes(size)) s.pagers[key].size = size;
    }
  }
  return s;
}
