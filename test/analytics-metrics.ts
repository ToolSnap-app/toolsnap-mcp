/**
 * Unit tests for Fase 25.15 — Analytics v2 (A): metricas corregidas.
 *
 * Origen (2026-10-20): el panel pintaba 59 "fallos nuestros" en 30 dias y el
 * pager habia sonado 0 veces. Los 59 eran `402_rejected` + `no_payment_payload`
 * (el handshake normal de x402) que `error_rate_by_tool` pasaba por
 * `classifyToolError`, cuyo default es "internal". La invariante de la skill
 * ("our_errors es exactamente lo que suena en el movil") llevaba un mes rota.
 *
 * Covers:
 *  - isPagedToolError es EL predicado: sobre un lote de eventos, el panel
 *    (rollupErrorRates.our_errors) y el pager (maybeAlertError) aceptan
 *    exactamente los mismos.
 *  - El SQL de error_rate_by_tool solo trae tool_error; recent_errors excluye
 *    el handshake 402.
 *  - Las tres ventanas (24h/7d/30d) se cortan por ts sobre las mismas filas.
 *  - PAID_TYPES/EXECUTED_TYPES unicos: el digest cuenta oauth, la cuota de
 *    ScreenshotOne cuenta api_key y oauth.
 *  - El payload lleva by_window y retention.
 *
 * Pure logic — fake D1 (captura SQL y binds), fake KV, fetch capturado.
 *
 * Run: npx tsx test/analytics-metrics.ts
 */
import { isPagedToolError, classifyToolError } from "../src/alerts/error-classification.js";
import { maybeAlertError } from "../src/alerts/error-alerts.js";
import {
  getDashboardData,
  getWeeklySurfaceDigest,
  rollupErrorRates,
  rollupLatency,
  loggedFailureClass,
  paywallFunnelByWindow,
  WINDOW_KEYS,
  type ErrorRowIn,
} from "../src/analytics/queries.js";
import { PAID_TYPES, EXECUTED_TYPES } from "../src/analytics/payment-types.js";
import { ANALYTICS_RETENTION_DAYS, CONNECT_RETENTION_DAYS } from "../src/analytics/retention.js";

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name} — ${detail}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
interface Captured {
  sql: string;
  args: unknown[];
}
function fakeD1(rowsFor: (sql: string) => unknown[] = () => []): { db: D1Database; calls: Captured[] } {
  const calls: Captured[] = [];
  const db = {
    prepare(sql: string) {
      const entry: Captured = { sql, args: [] };
      calls.push(entry);
      const stmt = {
        bind(...args: unknown[]) {
          entry.args = args;
          return stmt;
        },
        async all() {
          return { results: rowsFor(sql), success: true, meta: {} };
        },
        async raw() {
          return rowsFor(sql);
        },
        async first() {
          return rowsFor(sql)[0] ?? null;
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

/** KV that never dedupes (so every call to maybeAlertError decides on its own). */
const openKv = {
  async get() {
    return null;
  },
  async put() {},
  async delete() {},
} as unknown as KVNamespace;

async function pagerWouldSend(ev: {
  toolName: string;
  paymentType: string;
  payer: string;
  client?: string | null;
  clientName?: string | null;
  detail?: string | null;
}): Promise<boolean> {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(String(init?.body ?? ""));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  try {
    maybeAlertError(
      { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c", X402_NONCES: openKv },
      ctx,
      ev
    );
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent.length > 0;
}

// ---------------------------------------------------------------------------
// 1. Un solo predicado para panel y pager
// ---------------------------------------------------------------------------
console.log("isPagedToolError == maybeAlertError, fila a fila");
{
  const now = Date.now();
  const batch: Array<ErrorRowIn & { type: string }> = [
    // El handshake que inflaba el panel: 402 sin wallet, desde un agente real.
    { ts: now, tool: "keyword_research", type: "402_rejected", detail: "no_payment_payload", payer: "anon:aaaa", client_name: "claude-code", client: "claude-cli/1.0" },
    // Fallo real nuestro: proveedor de COGS.
    { ts: now, tool: "screenshot_url", type: "tool_error", detail: "ScreenshotOne: capture timed out", payer: "anon:bbbb", client_name: "claude-code", client: "claude-cli/1.0" },
    // Mismo fallo, pero de un escaner: no pagina, no es rojo.
    { ts: now, tool: "screenshot_url", type: "tool_error", detail: "ScreenshotOne: capture timed out", payer: "anon:cccc", client_name: "glama", client: "glama/1" },
    // Mismo fallo, pruebas nuestras con la admin key.
    { ts: now, tool: "screenshot_url", type: "tool_error", detail: "ScreenshotOne: capture timed out", payer: "admin", client_name: "curl", client: "curl/8" },
    // Destino roto: upstream.
    { ts: now, tool: "fetch_extract", type: "tool_error", detail: "Fetch failed: HTTP 404 Not Found", payer: "anon:dddd", client_name: "python-script", client: "python-httpx/0.27" },
    // El agente llamo mal: caller.
    { ts: now, tool: "csv_query", type: "tool_error", detail: "`url` is required.", payer: "anon:eeee", client_name: "mcp", client: "node" },
    // Excepcion desconocida (internal por descarte), agente real: pagina.
    { ts: now, tool: "json_query", type: "tool_error", detail: "TypeError: Cannot read properties of undefined", payer: "0xabc", client_name: "cursor", client: "cursor/1" },
    // Sin detail: internal por descarte, pagina.
    { ts: now, tool: "rss_parse", type: "tool_error", detail: null, payer: "anon:ffff", client_name: null, client: null },
  ];

  let mismatches = 0;
  for (const row of batch) {
    const predicate = isPagedToolError({ paymentType: row.type, detail: row.detail, payer: row.payer, clientName: row.client_name, client: row.client });
    const pager = await pagerWouldSend({ toolName: row.tool, paymentType: row.type, payer: row.payer, client: row.client, clientName: row.client_name, detail: row.detail });
    if (predicate !== pager) {
      mismatches++;
      console.log(`     mismatch: ${row.tool} ${row.type} "${row.detail}" predicate=${predicate} pager=${pager}`);
    }
  }
  assert("every tool_error row: predicate == pager decision", mismatches === 0, `${mismatches} mismatches`);

  // El 402 sin wallet no es un tool_error: nunca es "nuestro".
  assert("402 handshake is never a paged tool error", !isPagedToolError({ paymentType: "402_rejected", detail: "no_payment_payload", payer: "anon:aaaa" }));
  assert("402 handshake would still classify as internal by default (why it must never reach the chart)", classifyToolError("no_payment_payload") === "internal");

  // Panel: rollupErrorRates sobre SOLO los tool_error del lote.
  const toolErrors = batch.filter((r) => r.type === "tool_error");
  const totals = new Map<string, number>([["screenshot_url", 10], ["fetch_extract", 100], ["csv_query", 5], ["json_query", 2], ["rss_parse", 1]]);
  const rates = rollupErrorRates(toolErrors, totals, now - 1000);
  const byTool = new Map(rates.map((r) => [r.tool, r]));
  // Secuencial a proposito: pagerWouldSend sustituye globalThis.fetch.
  let pagedCount = 0;
  for (const r of toolErrors) {
    if (await pagerWouldSend({ toolName: r.tool, paymentType: r.type, payer: r.payer, client: r.client, clientName: r.client_name, detail: r.detail })) pagedCount++;
  }
  const ourTotal = rates.reduce((s, r) => s + r.our_errors, 0);
  assert("sum(our_errors) == number of rows the pager would send", ourTotal === pagedCount, `panel ${ourTotal} vs pager ${pagedCount}`);
  const su = byTool.get("screenshot_url")!;
  assert("screenshot_url: 1 paged (real agent), 2 muted (probe + admin)", su.our_errors === 1 && su.muted_errors === 2 && su.errors === 3, JSON.stringify(su));
  assert("fetch_extract: upstream only, 1% of 100 calls", byTool.get("fetch_extract")!.upstream_errors === 1 && byTool.get("fetch_extract")!.error_pct === 1);
  assert("csv_query: caller only", byTool.get("csv_query")!.caller_errors === 1 && byTool.get("csv_query")!.our_errors === 0);
  assert("json_query unknown exception pages", byTool.get("json_query")!.our_errors === 1);
  assert("missing detail pages", byTool.get("rss_parse")!.our_errors === 1);
  assert("keyword_research (only 402s) is not in the chart at all", !byTool.has("keyword_research"));
  assert("classes add up per tool", rates.every((r) => r.our_errors + r.upstream_errors + r.caller_errors + r.muted_errors === r.errors));
}

// ---------------------------------------------------------------------------
// 2. Ventanas: mismas filas, tres cortes
// ---------------------------------------------------------------------------
console.log("\nventanas 24h / 7d / 30d");
{
  const now = Date.now();
  const H = 3600_000;
  const rows: ErrorRowIn[] = [
    { ts: now - 1 * H, tool: "fetch_extract", detail: "Fetch failed: HTTP 500", payer: "anon:1", client_name: "x", client: "x" },
    { ts: now - 30 * H, tool: "fetch_extract", detail: "Fetch failed: HTTP 500", payer: "anon:1", client_name: "x", client: "x" },
    { ts: now - 10 * 24 * H, tool: "fetch_extract", detail: "Fetch failed: HTTP 500", payer: "anon:1", client_name: "x", client: "x" },
  ];
  const totals = new Map([["fetch_extract", 30]]);
  const h24 = rollupErrorRates(rows, totals, now - 24 * H)[0];
  const d7 = rollupErrorRates(rows, totals, now - 7 * 24 * H)[0];
  const d30 = rollupErrorRates(rows, totals, now - 30 * 24 * H)[0];
  assert("24h sees 1, 7d sees 2, 30d sees 3", h24.errors === 1 && d7.errors === 2 && d30.errors === 3, `${h24.errors}/${d7.errors}/${d30.errors}`);

  const lat = [
    { ts: now - 1 * H, tool: "a", latency_ms: 100 },
    { ts: now - 1 * H, tool: "a", latency_ms: 300 },
    { ts: now - 3 * 24 * H, tool: "b", latency_ms: 1000 },
  ];
  const l24 = rollupLatency(lat, now - 24 * H);
  const l7 = rollupLatency(lat, now - 7 * 24 * H);
  assert("latency 24h: avg 200 over 2 rows, one tool", l24.avg_latency_ms === 200 && l24.latency_by_tool.length === 1, JSON.stringify(l24));
  assert("latency 7d: two tools, p95 = 1000", l7.latency_by_tool.length === 2 && l7.p95_latency_ms === 1000, JSON.stringify(l7));
  assert("latency on an empty window is all zeros", rollupLatency(lat, now).avg_latency_ms === 0 && rollupLatency(lat, now).latency_by_tool.length === 0);

  assert("loggedFailureClass: 402 verification failure is 'payment'", loggedFailureClass("402_rejected", "signature invalid") === "payment");
  assert("loggedFailureClass: settle_failed is 'money'", loggedFailureClass("settle_failed", "Settle timed out on-chain") === "money");
  assert("loggedFailureClass: tool_error delegates to the classifier", loggedFailureClass("tool_error", "Fetch failed: HTTP 404") === "upstream");
}

// ---------------------------------------------------------------------------
// 3. SQL del panel: solo tool_error en el grafico, sin handshake en el log
// ---------------------------------------------------------------------------
console.log("\nSQL de getDashboardData");
{
  const { db, calls } = fakeD1();
  const data = await getDashboardData(db, true, { fresh: true });
  const errorChart = calls.filter((c) => /LIMIT 20000/.test(c.sql) && /detail/.test(c.sql) && !/latency_ms/.test(c.sql));
  assert("exactly one raw-error query feeds the chart", errorChart.length === 1, `${errorChart.length}`);
  assert("...and it only selects payment_type = 'tool_error'", /payment_type = 'tool_error'/.test(errorChart[0].sql) && !/402_rejected/.test(errorChart[0].sql));
  const recent = calls.find((c) => /LIMIT 200\b/.test(c.sql));
  assert("recent_errors excludes the no_payment_payload handshake", !!recent && /NOT \(payment_type = '402_rejected'/.test(recent.sql));
  assert("recent_errors selects client_name", !!recent && /client_name/.test(recent.sql));
  assert("payload has the three windows", WINDOW_KEYS.every((k) => data.by_window[k] !== undefined) && Object.keys(data.by_window).length === 3);
  assert("payload carries retention 365/60", data.retention.events_days === ANALYTICS_RETENTION_DAYS && data.retention.connect_days === CONNECT_RETENTION_DAYS && ANALYTICS_RETENTION_DAYS === 365 && CONNECT_RETENTION_DAYS === 60);
  assert("legacy 30d fields still present", data.summary.calls_30d === 0 && Array.isArray(data.error_rate_by_tool) && Array.isArray(data.top_tools));
  assert("no query reads the table without a ts bound except balances/directory_stats/analytics_daily (<= 365 dias)/MIN(ts)", calls.every((c) => /ts >= \?|ts < \?|FROM balances|FROM directory_stats|FROM analytics_daily|MIN\(ts\)|MAX\(ts\)/.test(c.sql)), calls.filter((c) => !/ts >= \?|ts < \?|FROM balances|FROM directory_stats|FROM analytics_daily|MIN\(ts\)|MAX\(ts\)/.test(c.sql)).map((c) => c.sql.slice(0, 60)).join(" | "));
  const windowed = calls.filter((c) => /SUM\(ts >= \?\)/.test(c.sql));
  assert("windowed queries bind 7d then 24h then 30d in that order", windowed.length >= 4 && windowed.every((c) => c.args.length >= 3 && (c.args[c.args.length - 1] as number) < (c.args[0] as number) && (c.args[0] as number) < (c.args[1] as number)), `${windowed.length} windowed`);
}

// ---------------------------------------------------------------------------
// 4. Embudo por ventanas
// ---------------------------------------------------------------------------
console.log("\npaywallFunnelByWindow");
{
  const { db, calls } = fakeD1(() => [{ h0: 10, h1: 4, h2: 1, c0: 3, c1: 2, c2: 0 }]);
  const out = await paywallFunnelByWindow(db, 0, [0, 1, 2], "");
  assert("one query for three windows", calls.length === 1);
  assert("maps h/c columns per boundary", out[0].hit_payers === 10 && out[1].converted_payers === 2 && out[2].hit_payers === 1 && out[2].converted_payers === 0, JSON.stringify(out));
  assert("binds since, PAID_TYPES, boundaries twice", calls[0].args.length === 1 + PAID_TYPES.length + 6, `${calls[0].args.length}`);
}

// ---------------------------------------------------------------------------
// 5. Una sola definicion de "pagado"
// ---------------------------------------------------------------------------
console.log("\nPAID_TYPES unico");
{
  assert("PAID_TYPES includes oauth", (PAID_TYPES as readonly string[]).includes("oauth"));
  assert("EXECUTED_TYPES includes api_key and oauth (ScreenshotOne quota)", (EXECUTED_TYPES as readonly string[]).includes("api_key") && (EXECUTED_TYPES as readonly string[]).includes("oauth") && (EXECUTED_TYPES as readonly string[]).includes("free_tool"));
  const { db, calls } = fakeD1();
  await getWeeklySurfaceDigest(db, Date.now());
  const paidQuery = calls.find((c) => /payment_type IN \(\?/.test(c.sql) && !/hits AS/.test(c.sql));
  assert("weekly digest counts paid calls with the shared PAID_TYPES (oauth included)", !!paidQuery && paidQuery.args.includes("oauth") && paidQuery.args.filter((a) => (PAID_TYPES as readonly string[]).includes(String(a))).length === PAID_TYPES.length, paidQuery ? JSON.stringify(paidQuery.args) : "no paid query");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
