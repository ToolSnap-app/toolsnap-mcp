/**
 * Fase 25.18 — Analytics v2 (C): panel /analytics en ficheros propios.
 *
 * Covers:
 *  - Las funciones puras de src/analytics/panel/panel-lib.js: formato (fmt,
 *    fmtUsd), series (zeroFillDaily, bucketWeekly, zeroFillIntraday,
 *    windowDelta), paginate, el KPI de paywall, el resumen de COGS, el split
 *    real/escaner, la salud y el estado guardado.
 *  - El ensamblado (assemblePanel): CSS y JS en su sitio, sin la linea de
 *    import, sin `</script>` suelto.
 *  - Higiene del markup: ni `style=` inline ni `onclick=` (eventos delegados),
 *    `<th scope>` en las tablas, aria-pressed en los segmentados.
 *  - El payload de fixture (test/_support/dashboard-fixture.ts) tiene la forma
 *    de DashboardData que el panel espera, incluida by_window[*].cogs.
 *
 * Pure logic — sin DOM. Run: npx tsx test/analytics-panel.ts
 */
import "./_support/text-modules.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fmt, fmtUsd, fmtPct, zeroFillDaily, bucketWeekly, zeroFillIntraday, bucketIntraday, windowDelta,
  paginate, paywallRate, cogsSummary, groupSurface, healthSummary, retentionParts, sanitizeState, seriesForTimeframe,
  niceMax, formatXLabel, partialLabel, truncatePayer, timeLabel, winKey, classifyDataResponse,
} from "../src/analytics/panel/panel-lib.js";
import { buildDashboardFixture } from "./_support/dashboard-fixture.js";
import { WINDOW_KEYS } from "../src/analytics/queries.js";

const { assemblePanel, PANEL_HTML } = await import("../src/analytics/panel.js");

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Un instante fijo (UTC) para que las series sean deterministas.
const NOW = Date.UTC(2026, 9, 20, 10, 17, 0); // 2026-10-20 10:17 UTC
const DAY = 86400000;

console.log("formato");
assert("fmt entero con separador", fmt(1284, 0) === "1,284", fmt(1284, 0));
assert("fmt compacta desde 10k", fmt(12840, 0) === "12.8k" && fmt(999, 0) === "999" && fmt(2500000, 0) === "2.5M", fmt(12840, 0));
assert("fmt null es guion", fmt(null) === "–");
assert("fmt decimales por defecto", fmt(3.14159) === "3.14");
assert("fmtUsd recorta ceros", fmtUsd(0.47) === "$0.47" && fmtUsd(0.4718) === "$0.4718", fmtUsd(0.4718));
assert("fmtUsd cero", fmtUsd(0) === "$0" && fmtUsd(-0) === "$0");
assert("fmtUsd miles", fmtUsd(1234.5) === "$1.2k");
assert("fmtPct sin denominador", fmtPct(3, 0) === "–" && fmtPct(1, 3) === "33%");
assert("truncatePayer recorta wallets", truncatePayer("0x1234567890abcdef1234567890abcdef12345678") === "0x12345678…5678");
assert("timeLabel es UTC", timeLabel(Date.UTC(2026, 9, 19, 12, 4, 31)) === "12:04:31 · 19 Oct", timeLabel(Date.UTC(2026, 9, 19, 12, 4, 31)));

console.log("series");
const daily = zeroFillDaily([{ day: "2026-10-20", calls: 5 }, { day: "2026-10-18", calls: 2 }], "calls", 4, NOW);
assert("zeroFillDaily rellena a 0 y acaba hoy", eq(daily.map((d) => d.value), [0, 2, 0, 5]) && daily[3].day === "2026-10-20", JSON.stringify(daily));
const fourteen = zeroFillDaily(Array.from({ length: 14 }, (_, i) => ({ day: new Date(NOW - (13 - i) * DAY).toISOString().slice(0, 10), calls: i + 1 })), "calls", 16, NOW);
const weeks = bucketWeekly(fourteen);
assert("bucketWeekly descarta los dias sueltos y suma por semana", weeks.length === 2 && weeks[0].value === 28 && weeks[1].value === 77, JSON.stringify(weeks));
assert("bucketWeekly empieza la semana en su primer dia", weeks[0].day === new Date(NOW - 13 * DAY).toISOString().slice(0, 10));
const delta = windowDelta(fourteen, 7);
// fase 25.21: el ultimo dia (parcial) queda fuera. Dias completos: [0,0,1..13] -> 7..13 = 70 frente a 0..6 = 21.
assert("windowDelta compara dias completos: deja fuera el dia parcial", delta !== null && delta.pct === 233 && delta.up === true && delta.through === new Date(NOW - DAY).toISOString().slice(0, 10), JSON.stringify(delta));
const fullDays = fourteen.map(({ day, value }) => ({ day, value }));
assert("windowDelta sin marca partial usa todos los puntos", eq(windowDelta(fullDays, 7), { pct: 175, up: true, through: fullDays[15].day }), JSON.stringify(windowDelta(fullDays, 7)));
assert("windowDelta sin base es null", windowDelta(fourteen, 10) === null && windowDelta([{ day: "x", value: 0 }, { day: "y", value: 3 }], 1) === null);
console.log("dia parcial (fase 25.21)");
const pd = zeroFillDaily([], "calls", 5, NOW);
assert("zeroFillDaily marca partial solo el ultimo punto (el dia UTC en curso)", pd.every((p, i) => (i === 4) === (p.partial === true)) && !("partial" in pd[0]), JSON.stringify(pd));
const atMidnight = zeroFillDaily([], "calls", 5, Date.UTC(2026, 9, 20));
assert("a medianoche UTC exacta ningun punto es parcial", atMidnight.length === 5 && atMidnight.every((p) => !("partial" in p)) && atMidnight[4].day === "2026-10-20", JSON.stringify(atMidnight));
const oneMsIn = zeroFillDaily([], "calls", 2, Date.UTC(2026, 9, 20) + 1);
assert("un milisegundo despues de medianoche ya es parcial", oneMsIn[1].partial === true);
// Delta estable: un dia a medias no hunde la comparacion. 14 dias completos de 10 + hoy con 1.
const stable = Array.from({ length: 14 }, (_, i) => ({ day: new Date(NOW - (14 - i) * DAY).toISOString().slice(0, 10), calls: 10 }));
stable.push({ day: "2026-10-20", calls: 1 });
const stableSeries = zeroFillDaily(stable, "calls", 15, NOW);
const stableDelta = windowDelta(stableSeries, 7);
assert("el delta ignora el dia parcial (10 por dia y hoy con 1 -> 0%, no -13%)", stableDelta !== null && stableDelta.pct === 0 && stableDelta.up === true, JSON.stringify(stableDelta));
assert("la ventana anterior se alinea sobre dias completos (sin hoy hay 14, con 7+7 sobra 0)", windowDelta(zeroFillDaily(stable, "calls", 14, NOW), 7) === null || windowDelta(zeroFillDaily(stable, "calls", 14, NOW), 7)!.through === "2026-10-19");
const wk = bucketWeekly(zeroFillDaily([], "calls", 15, NOW));
assert("bucketWeekly: solo la semana que contiene hoy es parcial", wk.length === 2 && !("partial" in wk[0]) && wk[1].partial === true, JSON.stringify(wk));
assert("partialLabel: dia, semana y punto completo", partialLabel({ partial: true }, "day") === "today, partial" && partialLabel({ partial: true }, "week") === "includes today, partial" && partialLabel({}, "day") === "" && partialLabel(undefined, "day") === "");
const intra = zeroFillIntraday([{ ts: Math.floor(NOW / 1800000) * 1800000, calls: 3 }], "calls", 2, 1800000, NOW);
assert("zeroFillIntraday: 2 h en medias horas, la ultima es ahora", intra.length === 4 && intra[3].value === 3 && intra[0].value === 0);
assert("bucketIntraday agrupa por factor", eq(bucketIntraday(intra, 2).map((x) => x.value), [0, 3]));
assert("niceMax redondea arriba a 1/2/5", niceMax(37) === 50 && niceMax(120) === 200 && niceMax(0) === 1 && niceMax(7) === 10);
assert("formatXLabel", formatXLabel("2026-10-19", "day") === "19 Oct" && formatXLabel("2026-10-19", "week") === "Oct" && formatXLabel("2026-10-19T08:30:00.000Z", "intraday") === "08:30");

const fx = buildDashboardFixture(NOW);
const s30 = seriesForTimeframe(fx, 30, "1h", NOW);
const last30 = new Set(Array.from({ length: 30 }, (_, i) => new Date(NOW - i * DAY).toISOString().slice(0, 10)));
const sum30 = fx.calls_by_day.filter((d) => last30.has(d.day)).reduce((s, d) => s + d.calls, 0);
assert("seriesForTimeframe 30d: 30 puntos diarios, suma = los 30 dias naturales de calls_by_day", s30.calls.length === 30 && s30.granularity === "day" && s30.callsSum === sum30, `${s30.callsSum} vs ${sum30}`);
const s1 = seriesForTimeframe(fx, 1, "4h", NOW);
const lastCalls = s30.calls[29], todayKey = new Date(NOW).toISOString().slice(0, 10);
assert("seriesForTimeframe 30d: el ultimo punto es hoy y es parcial; los 29 anteriores no", lastCalls.day === todayKey && lastCalls.partial === true && s30.calls.slice(0, 29).every((p) => !("partial" in p)));
assert("seriesForTimeframe: delta con dias completos, la suma de la tarjeta si incluye hoy", s30.callsDelta === null || s30.callsDelta.through === new Date(NOW - DAY).toISOString().slice(0, 10));
const s7 = seriesForTimeframe(fx, 7, "1h", NOW);
assert("seriesForTimeframe 7d: delta sobre dias completos y hoy con pocas llamadas (fixture) no lo hunde", s7.callsDelta !== null && s7.callsDelta.through === new Date(NOW - DAY).toISOString().slice(0, 10) && s7.calls[6].value <= 3 && Math.abs(s7.callsDelta.pct) < 60, JSON.stringify(s7.callsDelta));
assert("seriesForTimeframe 1y: la ultima semana es parcial", seriesForTimeframe(fx, 365, "1h", NOW).calls[51].partial === true);
assert("seriesForTimeframe 24h: la serie intradia no lleva marca partial", seriesForTimeframe(fx, 1, "1h", NOW).calls.every((p) => !("partial" in p)));
assert("seriesForTimeframe 24h a 4h: 6 buckets", s1.calls.length === 6 && s1.granularity === "intraday" && s1.callsDelta === null);
const s365 = seriesForTimeframe(fx, 365, "1h", NOW);
assert("seriesForTimeframe 1y: 52 semanas", s365.calls.length === 52 && s365.granularity === "week");

console.log("paginacion y KPIs");
const items = Array.from({ length: 42 }, (_, i) => i);
const p0 = paginate(items, 0, 15);
assert("paginate primera pagina", p0.pageItems.length === 15 && p0.start === 1 && p0.end === 15 && p0.maxPage === 2 && p0.total === 42);
const pLast = paginate(items, 9, 15);
assert("paginate fuera de rango cae a la ultima", pLast.page === 2 && pLast.pageItems.length === 12 && pLast.start === 31 && pLast.end === 42);
assert("paginate vacio", eq(paginate([], 3, 10), { pageItems: [], total: 0, page: 0, maxPage: 0, start: 0, end: 0 }));
assert("paywallRate", paywallRate({ hit_payers: 8, converted_payers: 3 }) === 38 && paywallRate({ hit_payers: 0, converted_payers: 0 }) === null && paywallRate(null) === null);
const cg = cogsSummary({ revenue: 2, cogs: [{ tool: "screenshot_url", calls: 30, cogs_usdc: 0.27 }, { tool: "keyword_research", calls: 10, cogs_usdc: 0.03 }] });
assert("cogsSummary suma, margen y %", cg !== null && Math.abs(cg.total - 0.3) < 1e-9 && Math.abs(cg.margin - 1.7) < 1e-9 && cg.marginPct === 85, JSON.stringify(cg));
assert("cogsSummary null sin filas", cogsSummary({ revenue: 2, cogs: [] }) === null && cogsSummary(undefined) === null);
const surf = groupSurface([{ client: "cursor", calls: 5, probe: false }, { client: "cursor", calls: 9, probe: true }, { client: "claude-ai", calls: 20, probe: false }]);
assert("groupSurface junta real y escaner por cliente, ordena por total", eq(surf, [{ client: "claude-ai", real: 20, scanner: 0 }, { client: "cursor", real: 5, scanner: 9 }]), JSON.stringify(surf));
assert("winKey: 90d y 1y ensenan 30d", winKey(90) === "d30" && winKey(365) === "d30" && winKey(1) === "h24" && winKey(7) === "d7");

console.log("salud, retencion y estado");
const okH = healthSummary({ broken_tools: [], last_event_ts: NOW - 60000, crons: [{ name: "health", last_ok_ts: NOW, last_error: null, last_error_ts: null, muted: false }] }, NOW);
assert("salud ok", okH !== null && okH.ok && okH.problems.length === 0);
const badH = healthSummary({
  broken_tools: [{ tool: "screenshot_url", total: 9, errors: 8, pct: 89, payers: 4, topDetail: "quota" }],
  last_event_ts: NOW - 4 * 3600000,
  crons: [
    { name: "usage-alerts", last_ok_ts: NOW - DAY, last_error: "D1 down", last_error_ts: NOW - 1000, muted: false },
    { name: "x-agent-metrics", last_ok_ts: null, last_error: "402", last_error_ts: NOW - 1000, muted: true },
    { name: "recovered", last_ok_ts: NOW, last_error: "old", last_error_ts: NOW - 5000, muted: false },
  ],
}, NOW);
assert("salud con problemas: tool rota + silencio + cron (el recuperado no, el muted va a notas)", badH !== null && !badH.ok && badH.problems.length === 3 && badH.notes.length === 1, JSON.stringify(badH));
// Fase 25.19 — una tool "rota" que el canario desmiente es nota, no problema; si el canario falla, el problema lo dice.
const canH = healthSummary({
  broken_tools: [{ tool: "fetch_extract", total: 7, errors: 7, pct: 100, payers: 3, topDetail: "Fetch failed: HTTP 403 Forbidden", kinds: "caller+upstream", paged: false }],
  canary: { ok: true, detail: "https://www.cloudflare.com/robots.txt" },
  last_event_ts: NOW - 60000, crons: [],
}, NOW);
assert("canario OK: la tool va a notas y la salud sigue ok", canH !== null && canH.ok && canH.problems.length === 0 && canH.notes.length === 1 && /not paged/.test(canH.notes[0]), JSON.stringify(canH));
const canBad = healthSummary({
  broken_tools: [{ tool: "fetch_extract", total: 7, errors: 7, pct: 100, payers: 3, topDetail: "x", kinds: "upstream", paged: true }],
  canary: { ok: false, detail: "https://www.cloudflare.com/robots.txt → HTTP 503" },
  last_event_ts: NOW - 60000, crons: [],
}, NOW);
assert("canario caido: problema con la prueba del canario", canBad !== null && !canBad.ok && canBad.problems.length === 1 && /canary fetch failing too/.test(canBad.problems[0]), JSON.stringify(canBad));
const ret = { events_days: 365, connect_days: 60, oldest_event_ts: NOW - 114 * DAY, surface_days: 7 };
assert("retention: 7d no avisa", retentionParts(ret, 7).length === 0);
assert("retention: 30d avisa de connects", eq(retentionParts(ret, 30), ["connects and directory coverage cover 7d"]));
assert("retention: 1y avisa de todo", retentionParts(ret, 365).length === 4 && retentionParts(ret, 365)[2].startsWith("events since 2026-06-"));
const defaults = { days: 30, view: "line", internal: false, tab: "overview", granularity: "1h", pagers: { errors: { page: 0, size: 15 } } };
const st = sanitizeState({ days: 7, view: "pie", internal: true, tab: "logs", granularity: "2h", pagers: { errors: { size: 50 }, bogus: { size: 10 } } }, defaults);
assert("sanitizeState acepta lo valido e ignora lo demas", eq(st, { days: 7, view: "line", internal: true, tab: "logs", granularity: "1h", pagers: { errors: { page: 0, size: 50 } } }), JSON.stringify(st));
assert("sanitizeState con basura devuelve los defaults", eq(sanitizeState("nope", defaults), defaults));

console.log("ensamblado e higiene del markup");
const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/analytics/panel");
const [html, css, lib, app] = await Promise.all(["panel.html", "panel.css", "panel-lib.js", "panel.js"].map((f) => readFile(join(dir, f), "utf8")));
const page = assemblePanel(html, css, lib, app);
assert("PANEL_HTML es el ensamblado de los cuatro ficheros", PANEL_HTML === page);
assert("CSS inyectado en su hueco", page.includes("--font-ui:") && !page.includes("/*__PANEL_CSS__*/"));
assert("JS inyectado sin la linea de import", !/^\s*import\s*\{/m.test(page) && page.includes("function render(") && page.includes("export function fmt("));
assert("un unico <script type=\"module\"> y ningun </script> dentro del JS", page.match(/<script/g)?.length === 1 && page.match(/<\/script>/g)?.length === 1);
const markup = html + "\n" + app;
assert("sin style= inline en html ni js", !/\sstyle\s*=/.test(markup), (markup.match(/[^\n]*\sstyle\s*=[^\n]*/g) ?? []).slice(0, 3).join(" | "));
assert("sin onclick= ni otros on*= en el markup (eventos delegados)", !/\son[a-z]+\s*=/.test(markup), (markup.match(/[^\n]*\son[a-z]+\s*=[^\n]*/g) ?? []).slice(0, 3).join(" | "));
assert("las tablas llevan <th scope=\"col\">", (app.match(/<th scope="col"/g) ?? []).length >= 1 && !/<th(?=[\s>])(?! scope)/.test(app));
assert("los segmentados llevan aria-pressed", (html.match(/aria-pressed=/g) ?? []).length >= 12 && (app.match(/aria-pressed/g) ?? []).length >= 4);
assert("panel.html declara solo tema oscuro (sin prefers-color-scheme)", !css.includes("prefers-color-scheme") && html.includes('name="color-scheme" content="dark"'));
assert("tipografia: nada de Inter / Space Grotesk / JetBrains Mono como voz de la casa", !/Inter|Space Grotesk|JetBrains/.test(css));
assert("sin em dashes en el texto visible del panel", !html.includes("—") && !/'[^'\n]*—[^'\n]*'/.test(app));
assert("sin glow ni sombras por defecto", !/text-shadow|backdrop-filter|blur\(|box-shadow:[^;]*\b0 0 \d+px/.test(css) && (css.match(/box-shadow/g) ?? []).length <= 2);
assert("todos los paneles del HTML se pintan en panel.js", (html.match(/data-panel="([a-z-]+)"/g) ?? []).map((m) => m.slice(12, -1)).every((name) => app.includes(`'${name}'`)));

console.log("dia parcial en el markup (fase 25.21)");
assert("panel.js dibuja el parcial: tramo discontinuo, punto hueco, barra atenuada y etiqueta en el tooltip", app.includes("line-partial") && app.includes("partial-dot") && app.includes("' partial'") && app.includes("partialLabel(") && css.includes(".line-partial") && css.includes(".partial-dot") && css.includes(".bar-mark.partial"));
assert("el ultimo valor anotado es el del ultimo punto completo (lastIdx)", app.includes("const lastIdx = hasPartial ? n - 2 : n - 1") && app.includes("series[lastIdx].value"));
assert("el parcial no usa sombras ni glow en el CSS nuevo", !/partial[^\n]*(shadow|blur|drop-shadow)/.test(css));

console.log("respuesta de /analytics/data (fase 25.20: sesion de Access caducada)");
{
  const c = (res: Record<string, unknown>, body?: unknown) => classifyDataResponse(res, body);
  assert("302 de Access con redirect:'manual' (opaqueredirect, status 0) → expired", c({ type: "opaqueredirect", status: 0, ok: false, contentType: "" }).kind === "expired");
  assert("401 del Worker (sin cabecera de Access) → expired", c({ type: "basic", status: 401, ok: false, contentType: "application/json" }).kind === "expired");
  assert("200 con HTML (pagina de login) → expired", c({ type: "basic", status: 200, ok: true, contentType: "text/html; charset=utf-8" }).kind === "expired");
  const q = c({ type: "basic", status: 503, ok: false, contentType: "application/json" }, { error: "temporarily_unavailable", reason: "database quota", retry_after_utc: "2026-10-26T00:00:00.000Z" });
  assert("503 de la fase E con cuota → unavailable y dice hasta cuando", q.kind === "unavailable" && /quota/.test(q.message) && /00:00/.test(q.message), q.message);
  assert("503 sin cuerpo → unavailable generico", c({ type: "basic", status: 503, ok: false, contentType: "" }).kind === "unavailable");
  assert("502 → http con mensaje de D1", c({ type: "basic", status: 502, ok: false, contentType: "" }).message.startsWith("D1 did not answer"));
  assert("200 JSON con cuerpo → ok", c({ type: "basic", status: 200, ok: true, contentType: "application/json" }, { kpis: {} }).kind === "ok");
  assert("200 JSON sin cuerpo → http", c({ type: "basic", status: 200, ok: true, contentType: "application/json" }, null).kind === "http");
  assert("panel.js pide los datos con redirect:'manual'", /fetch\('\/analytics\/data'[^\n]*redirect: 'manual'/.test(app));
  assert("panel.js ofrece volver a entrar (boton delegado data-signin) y recarga en fresco", app.includes('data-signin="1"') && app.includes("ds.signin") && app.includes("RELOAD_FRESH_KEY") && app.includes("location.reload()"));
  assert("panel.js no recarga en bucle: la recarga automatica exige !reloadedForSession", app.includes("force === true && !reloadedForSession") && app.includes("reloadedForSession = reloadFresh"));
}

console.log("fixture con la forma de DashboardData");
assert("fixture: tres ventanas con cogs", WINDOW_KEYS.every((k) => Array.isArray(fx.by_window[k].cogs) && Array.isArray(fx.by_window[k].top_tools)));
assert("fixture: cogs solo con tools > 0, ordenado desc", fx.by_window.d30.cogs.length > 0 && fx.by_window.d30.cogs.every((r) => r.cogs_usdc > 0) && fx.by_window.d30.cogs.every((r, i, a) => i === 0 || a[i - 1].cogs_usdc >= r.cogs_usdc));
assert("fixture: calls_by_client lleva probe", fx.by_window.d30.calls_by_client.some((r) => r.probe === true) && fx.surface.connects_by_client.some((r) => r.probe === true));
assert("fixture: health y retention presentes", fx.health.crons.length > 0 && fx.retention.surface_days === 7);
const empty = buildDashboardFixture(NOW, { scenario: "empty" });
assert("fixture vacio: sin COGS ni errores", empty.by_window.d30.cogs.length === 0 && empty.recent_errors.length === 0 && cogsSummary(empty.by_window.d30) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
