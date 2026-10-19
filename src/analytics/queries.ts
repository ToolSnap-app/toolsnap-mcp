/**
 * D1 queries for the analytics dashboard (/analytics/data endpoint).
 * All queries run against the analytics_events table (migration 0002).
 */

import { FAMILIES } from "../tools/catalog.js";
import { PROBE_CLIENTS, PROBE_NAME_PATTERNS, PROBE_UA_PATTERNS, isProbeClient } from "./surface.js";
import { classifyToolError, isPagedToolError, type ToolErrorClass } from "../alerts/error-classification.js";
import { PAID_TYPES, PAID_TYPES_SQL, DEPOSIT_TYPES_SQL } from "./payment-types.js";
import { ANALYTICS_RETENTION_DAYS, CONNECT_RETENTION_DAYS } from "./retention.js";

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_365D = 365 * 24 * 60 * 60 * 1000;

/** MCP directory/registry scrapers (see surface.ts PROBE_CLIENTS) — a fixed constant list, never user input. */
const PROBE_CLIENTS_SQL = Array.from(PROBE_CLIENTS)
  .map((c) => `'${c}'`)
  .join(", ");

/**
 * Fase 25.2 — predicate matching probe traffic by exact client_name OR by
 * naming-convention pattern (surface.ts PROBE_NAME_PATTERNS): new scanners
 * appear weekly, so the exact list alone always lags reality. Both constant
 * lists, never user input.
 */
const IS_PROBE_SQL = `(client_name IN (${PROBE_CLIENTS_SQL}) OR ${[
  ...PROBE_NAME_PATTERNS.map((p) => `client_name LIKE '${p}'`),
  // Fase 25.9 — la convencion de crawler en el User-Agent crudo
  // ("MiBot/0.1 (+https://mibot.example/bot)"). Espejo exacto de la rama
  // equivalente de isProbeClient (surface.ts): es la unica regla de esta
  // familia que no envejece, porque persigue la convencion y no el nombre.
  ...PROBE_UA_PATTERNS.map((p) => `client LIKE '${p}'`),
].join(" OR ")})`;

/**
 * SQL fragment excluding directory-probe traffic from demand metrics —
 * shared by the panel's internalFilter and the weekly digest so the two
 * report on the same notion of "real demand".
 */
const NON_PROBE_SQL = ` AND NOT COALESCE(${IS_PROBE_SQL}, 0)`;

/** tool_name -> family ids, precomputed once from the catalog (a tool can belong to >1 family). */
const TOOL_FAMILIES: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [familyId, family] of Object.entries(FAMILIES)) {
    for (const tool of family.tools) {
      (map[tool] ??= []).push(familyId);
    }
  }
  return map;
})();

/**
 * Fase 25.15 — tipos que aparecen en "Recent errors" (el log del panel).
 * NO alimentan error_rate_by_tool: ese grafico solo cuenta `tool_error`, que
 * es lo unico que puede ser un fallo de ToolSnap (ver isPagedToolError). El
 * handshake normal de x402 (402_rejected + no_payment_payload) tampoco entra
 * aqui: es Payment mix, no un error.
 */
const LOGGED_FAILURE_TYPES = [
  "402_rejected",
  "prepaid_insufficient",
  "prepaid_rejected",
  "deposit_failed",
  "fiat_deposit_failed",
  "api_key_rejected",
  "api_key_insufficient",
  "oauth_insufficient",
  "oauth_rejected",
  "settle_failed",
  "tool_error",
] as const;
const LOGGED_FAILURE_TYPES_SQL = LOGGED_FAILURE_TYPES.map((t) => `'${t}'`).join(", ");
const MONEY_FAILURE_TYPES: ReadonlySet<string> = new Set(["settle_failed", "deposit_failed", "fiat_deposit_failed"]);

/** Clase de una fila de "Recent errors": las tres del clasificador para tool_error, y dos de negocio. */
export type LoggedFailureClass = ToolErrorClass | "payment" | "money";

/**
 * Fase 25.15 — las tres ventanas que el selector del panel puede pedir SIN
 * leer una fila mas: cada consulta de 30 d devuelve ademas sus cortes a 7 d y
 * 24 h con SUM(CASE WHEN ts >= ?) sobre las mismas filas. 90d/1y no tienen
 * corte propio (costaria leer 365 d de eventos en cada carga): el panel
 * ensena 30 d y lo dice en el titulo.
 */
export type WindowKey = "h24" | "d7" | "d30";
export const WINDOW_KEYS: readonly WindowKey[] = ["h24", "d7", "d30"];

export interface ErrorRateRow {
  tool: string;
  total: number;
  errors: number;
  /** Lo que pagina: isPagedToolError. EXACTAMENTE lo que suena en Telegram. */
  our_errors: number;
  upstream_errors: number;
  caller_errors: number;
  /** Clase internal que NO pagina (probe o admin): visible, no roja. */
  muted_errors: number;
  error_pct: number;
}

export interface WindowStats {
  calls: number;
  revenue: number;
  unique_payers: number;
  unique_anon_agents: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  top_tools: Array<{ tool: string; calls: number }>;
  payment_breakdown: Array<{ type: string; calls: number }>;
  calls_by_client: Array<{ client: string; calls: number }>;
  /** Agentes (no llamadas) que vieron el 402 en la ventana y convirtieron en 7 d, cualquier rail. */
  paywall_funnel: { hit_payers: number; converted_payers: number };
  error_rate_by_tool: ErrorRateRow[];
  latency_by_tool: Array<{ tool: string; calls: number; p50_latency_ms: number; p95_latency_ms: number }>;
}

export interface DashboardData {
  summary: {
    calls_30d: number;
    /** Fase 24.7 — usage revenue only (x402/prepaid/api_key/oauth debits). Excludes deposit/purchase cash-in — see `credits`. */
    revenue_30d: number;
    unique_payers_30d: number;
    /**
     * Fase 24.6 — distinct anonymous agents (payer LIKE 'anon:%', the
     * salted IP-hash pseudonyms). Disjoint from unique_payers_30d, which
     * counts identified payers (wallets/accounts) only — before the hash,
     * all anonymous traffic collapsed into one literal "anon" and this
     * number was invisible.
     *
     * Fase 25.1 (fixed 2026-07-18) — two-step canonicalization: each session
     * gets an anchor (MIN(payer) within it), each payer canonicalizes to its
     * smallest anchor across sessions, then distinct canonical agents are
     * counted. This collapses IP rotation *within* a session (Anthropic's
     * egress rotates IPs mid-session; session 477838cd… on 2026-07-17 logged
     * one Claude agent as 4 anon payers) WITHOUT splitting one agent's many
     * sessions into many agents (the first 25.1 attempt grouped by session
     * and reported 1.4k agents where there were 5).
     */
    unique_anon_agents_30d: number;
    /**
     * Fase 24.7 — distinct payers (payer != 'anon', includes anon:% hashes)
     * seen both this week and the previous — a retention signal.
     *
     * Fase 25.1 (fixed 2026-07-18) — the same two-step canonicalization as
     * unique_anon_agents_30d, computed over the FULL 14-day window so both
     * weeks share one identity map, then the per-week canonical-agent sets
     * are intersected. (The first 25.1 attempt grouped by session on each
     * side, which made identities session-local and never comparable across
     * weeks — returning dropped to 0.) Not a full fix: an agent whose anchor
     * IP hash changes between weeks with no shared session still won't match
     * — acceptable residual for a pseudonymous metric.
     */
    returning_agents_7d: number;
    avg_latency_ms: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
  };
  calls_by_day: Array<{ day: string; calls: number }>;
  revenue_by_day: Array<{ day: string; revenue: number }>;
  /** Fase 24.7 — 30-minute buckets, last 7 days, for the intraday chart views (excludes connect + deposits, same as calls_by_day/revenue_by_day). */
  calls_by_halfhour: Array<{ ts: number; calls: number }>;
  revenue_by_halfhour: Array<{ ts: number; revenue: number }>;
  top_tools: Array<{ tool: string; calls: number }>;
  payment_breakdown: Array<{ type: string; calls: number }>;
  /**
   * Fase 24.7 — cash entering the system via either rail (crypto x402 deposit
   * or fiat Polar purchase), replacing the crypto-only `deposits` field.
   * `outstanding_usdc`/`lifetime_purchased_usdc`/`lifetime_consumed_usdc`/
   * `accounts` come straight from the `balances` table (source of truth for
   * money, see migrations/0001_prepaid.sql) — not derived from events.
   */
  credits: {
    purchased_30d: { crypto: { count: number; total_usdc: number }; fiat: { count: number; total_usdc: number } };
    outstanding_usdc: number;
    lifetime_purchased_usdc: number;
    lifetime_consumed_usdc: number;
    accounts: number;
  };
  /** Fase 24.7 — log of individual credit purchases (both rails), last 365d, newest first. */
  credit_purchases: Array<{ ts: number; type: string; payer: string; amount: number; detail: string | null }>;
  /** Fase 25.15 — sin el handshake 402 sin wallet; con client_name y clase (ver LoggedFailureClass). */
  recent_errors: Array<{
    ts: number;
    tool: string;
    type: string;
    class: LoggedFailureClass;
    /** true solo si este evento habria sonado en Telegram (isPagedToolError). */
    paged: boolean;
    payer: string;
    client_name: string | null;
    client: string | null;
    detail: string | null;
  }>;
  /** Fase 25.15 — todas las tarjetas que siguen al selector, por ventana. Los campos de arriba son el corte de 30 d (compatibilidad con /reports). */
  by_window: Record<WindowKey, WindowStats>;
  /** Fase 25.15 — para que el panel diga que cubre de verdad. */
  retention: { events_days: number; connect_days: number; oldest_event_ts: number | null };
  /**
   * Fase 24.6 / 25.9 — errores partidos en tres clases con el MISMO
   * clasificador que decide que pagina en Telegram (error-classification.ts):
   * `caller_errors` (el agente llamo mal), `upstream_errors` (el destino
   * fallo) y `our_errors` (fallo real de ToolSnap). La invariante que importa:
   * **our_errors es exactamente lo que suena en el movil**; lo demas se
   * registra y se mira aqui. `errors` sigue siendo el total combinado por
   * compatibilidad con los consumidores existentes.
   */
  error_rate_by_tool: ErrorRateRow[];
  /** Fase 24.6 — p50/p95 latency per tool (top 10 by call volume), catches a slow provider hidden by the global average. */
  latency_by_tool: Array<{ tool: string; calls: number; p50_latency_ms: number; p95_latency_ms: number }>;
  /**
   * Fase 24.6 — MCP directory/registry scrapers that connect and read the
   * catalog but aren't real agent demand (see surface.ts PROBE_CLIENTS).
   * Excluded from every other metric above; reported here on its own as a
   * listing-health signal, not discarded as noise.
   */
  directory_coverage: Array<{ client: string; hits: number; last_seen: number }>;
  /**
   * Fase 25.3 — external directory-listing stats (Smithery useCount, Glama
   * listing presence), snapshotted daily by the scheduled cron
   * (analytics/directory-stats.ts) since this table only holds ToolSnap's
   * own scheduled rows — not caller traffic, so it's outside internalFilter.
   */
  directory_stats: Array<{ source: string; use_count: number | null; ts: number }>;
  /** Fase 25.3 — Smithery useCount over the last 30 days, one point per snapshot day, for the panel chart. */
  smithery_use_count_series: Array<{ day: string; use_count: number }>;
  /**
   * Fase 24.6 — how many distinct payers hit the x402 paywall (402_rejected)
   * and, within 7 days after their first hit, converted (called
   * wallet_setup, or a payment_type of x402_paid/x402_free_first/prepaid/
   * api_key/oauth). Direct signal for whether the actionable 402
   * error.message (Fase 24.5) recovers lost conversion.
   */
  paywall_funnel: { hit_payers: number; converted_payers: number };
  /** Fase 24 — which MCP client/surface is connecting, calling, paying. */
  surface: {
    connects_by_client: Array<{ client: string; connects: number }>;
    calls_by_client: Array<{ client: string; calls: number }>;
    revenue_by_client: Array<{ client: string; revenue: number }>;
    /**
     * Per-surface funnel: connect -> >=1 tool call -> >=3 calls in the same
     * family (CP-tarea-completa, nota 07) -> paid call. Computed from raw
     * per-session rows (session_id present) rather than in SQL — session
     * counts are small at this stage; revisit if volume grows.
     */
    funnel_by_client: Array<{
      client: string;
      sessions: number;
      sessions_with_call: number;
      sessions_family_complete: number;
      sessions_paid: number;
    }>;
  };
}

/**
 * Fase 25.8 — el p50/p95 global se calcula en JS a partir de `latencyRows`
 * (las mismas filas que ya alimentan el desglose por tool), no en SQL.
 *
 * Antes: latencyPercentile() lanzaba 4 consultas por carga del panel (un
 * count + un `ORDER BY latency_ms LIMIT 1 OFFSET n` por cada percentil), y
 * ese ORDER BY sin indice era la consulta menos eficiente de todo el panel
 * (870k filas leidas en 7 dias, queryEfficiency 0.00004). Las filas ya
 * estaban en memoria: `latencyRows` trae todas las latencias no-connect de
 * la ventana de 30d (LIMIT 20000, holgado — hoy son ~2.2k).
 *
 * Sin cambio de resultado: los eventos `connect` se registran con
 * latency_ms = 0, asi que el viejo filtro `latency_ms > 0` ya los excluia,
 * exactamente igual que el `payment_type != 'connect'` de latencyRows.
 */

function dayLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Percentile of an in-memory array — used for the per-tool latency breakdown (bounded row fetch, see below). */
function percentileOf(sortedAsc: number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * fraction));
  return sortedAsc[idx];
}


/**
 * Fase 24.6 — how many distinct payers hit the x402 paywall (402_rejected)
 * in the window, and how many of them converted (called wallet_setup, or
 * made a paid-type call) within 7 days of a hit. Correlation needs TWO keys
 * because the payer label CHANGES on conversion: the 402 hit logs the
 * anon-hash pseudonym, but the successful x402 retry logs the wallet
 * address (and an API-key/OAuth payment logs acct:...). So a conversion
 * matches on either (a) same payer — covers wallet_setup and repeat anon
 * activity — or (b) same session_id — covers the classic 402 → sign →
 * retry flow, which happens within one MCP session (server-assigned since
 * Fase 24.5).
 *
 * Fase 25.15 — una sola consulta devuelve el embudo para VARIAS ventanas
 * (`boundaries`, cada una >= `since`): los hits se leen una vez y cada corte
 * es un count(DISTINCT CASE WHEN ts >= ?). Un agente cuenta como convertido
 * en la ventana en la que vio el 402, aunque pagara despues de cerrarse.
 */
export async function paywallFunnelByWindow(
  db: D1Database,
  since: number,
  boundaries: readonly number[],
  internalFilter: string
): Promise<Array<{ hit_payers: number; converted_payers: number }>> {
  const paidPlaceholders = PAID_TYPES.map(() => "?").join(", ");
  const hitCols = boundaries.map((_, i) => `count(DISTINCT CASE WHEN ts >= ? THEN payer END) AS h${i}`).join(", ");
  const convCols = boundaries
    .map((_, i) => `(SELECT count(DISTINCT CASE WHEN hit_ts >= ? THEN payer END) FROM converted) AS c${i}`)
    .join(", ");
  const row = await db
    .prepare(
      `WITH hits AS (
         SELECT payer, session_id, ts
         FROM analytics_events
         WHERE ts >= ? AND payment_type = '402_rejected'${internalFilter}
       ),
       converted AS (
         SELECT DISTINCT h.payer, h.ts AS hit_ts
         FROM hits h
         JOIN analytics_events e
           ON (e.payer = h.payer OR (h.session_id IS NOT NULL AND e.session_id = h.session_id))
          AND e.ts > h.ts
          AND e.ts <= h.ts + ${MS_7D}
          AND (e.tool_name = 'wallet_setup' OR e.payment_type IN (${paidPlaceholders}))
       )
       SELECT ${hitCols}, ${convCols} FROM hits`
    )
    .bind(since, ...PAID_TYPES, ...boundaries, ...boundaries)
    .first<Record<string, number>>();
  return boundaries.map((_, i) => ({
    hit_payers: row?.[`h${i}`] ?? 0,
    converted_payers: row?.[`c${i}`] ?? 0,
  }));
}

/** Una sola ventana (digest semanal). */
async function paywallConversionFunnel(
  db: D1Database,
  since: number,
  internalFilter: string
): Promise<{ hit_payers: number; converted_payers: number }> {
  const [w] = await paywallFunnelByWindow(db, since, [since], internalFilter);
  return w;
}

/**
 * Fase 25.8 — cache en memoria del isolate para el payload del panel.
 *
 * Una sola carga de /analytics/data lanza 25 consultas (24 sobre
 * analytics_events/directory_stats y 1 sobre balances; ~115k filas leidas al
 * dia en total con el uso real, medido en Fase 25.15). El panel se refresca solo, hay dos consumidores mas
 * (/reports/analytics y la rutina de review) y un F5 repetido recalculaba
 * todo. 5 min de TTL absorben las rafagas (recargas seguidas, dos pestanas
 * abiertas, el boton ↻ pulsado varias veces) sin que el dashboard se note
 * desactualizado: mide un servidor con ~150 llamadas al dia.
 *
 * Es estado de isolate, no un binding: se pierde al reciclarse el isolate y
 * no se comparte entre colos. Eso basta — es un amortiguador de rafagas, no
 * una fuente de verdad — y evita meter datos privados del panel en la Cache
 * API compartida del edge.
 */
const DASHBOARD_TTL_MS = 5 * 60_000;
const dashboardCache = new Map<string, { at: number; data: DashboardData }>();

export async function getDashboardData(
  db: D1Database,
  includeInternal = false
): Promise<DashboardData> {
  const key = includeInternal ? "internal" : "external";
  const hit = dashboardCache.get(key);
  if (hit && Date.now() - hit.at < DASHBOARD_TTL_MS) return hit.data;
  const fresh = await computeDashboardData(db, includeInternal);
  dashboardCache.set(key, { at: Date.now(), data: fresh });
  return fresh;
}

/** Fila cruda de tool_error de los ultimos 30 d: lo minimo para clasificar y cortar por ventana. */
export interface ErrorRowIn {
  ts: number;
  tool: string;
  detail: string | null;
  payer: string;
  client_name: string | null;
  client: string | null;
}

/**
 * Fase 25.15 — error_rate_by_tool de UNA ventana a partir de las filas crudas
 * (solo tool_error) y los totales por tool. Exportada para el test que afirma
 * la invariante: `our_errors` cuenta exactamente las filas que
 * isPagedToolError acepta, es decir, las que el pager habria enviado.
 */
export function rollupErrorRates(
  rows: readonly ErrorRowIn[],
  totals: ReadonlyMap<string, number>,
  since: number
): ErrorRateRow[] {
  const agg = new Map<string, { errors: number; our: number; upstream: number; caller: number; muted: number }>();
  for (const row of rows) {
    if (row.ts < since) continue;
    const a = agg.get(row.tool) ?? { errors: 0, our: 0, upstream: 0, caller: 0, muted: 0 };
    a.errors += 1;
    const kind = classifyToolError(row.detail);
    if (kind === "upstream") a.upstream += 1;
    else if (kind === "caller") a.caller += 1;
    else if (
      isPagedToolError({
        paymentType: "tool_error",
        detail: row.detail,
        payer: row.payer,
        clientName: row.client_name,
        client: row.client,
      })
    )
      a.our += 1;
    else a.muted += 1;
    agg.set(row.tool, a);
  }
  return Array.from(agg.entries())
    .map(([tool, a]) => {
      const total = totals.get(tool) ?? a.errors;
      return {
        tool,
        total,
        errors: a.errors,
        our_errors: a.our,
        upstream_errors: a.upstream,
        caller_errors: a.caller,
        muted_errors: a.muted,
        error_pct: total > 0 ? Math.round((a.errors / total) * 100) : 0,
      };
    })
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10);
}

/** Fase 25.15 — latencia de una ventana: global (avg/p50/p95) y por tool (top 10 por volumen). */
export function rollupLatency(
  rows: readonly { ts: number; tool: string; latency_ms: number }[],
  since: number
): Pick<WindowStats, "avg_latency_ms" | "p50_latency_ms" | "p95_latency_ms" | "latency_by_tool"> {
  const all: number[] = [];
  let sum = 0;
  const byTool = new Map<string, number[]>();
  for (const row of rows) {
    if (row.ts < since) continue;
    all.push(row.latency_ms);
    sum += row.latency_ms;
    const arr = byTool.get(row.tool);
    if (arr) arr.push(row.latency_ms);
    else byTool.set(row.tool, [row.latency_ms]);
  }
  all.sort((a, b) => a - b);
  const latency_by_tool = Array.from(byTool.entries())
    .map(([tool, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { tool, calls: sorted.length, p50_latency_ms: percentileOf(sorted, 0.5), p95_latency_ms: percentileOf(sorted, 0.95) };
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);
  return {
    avg_latency_ms: all.length ? Math.round(sum / all.length) : 0,
    p50_latency_ms: percentileOf(all, 0.5),
    p95_latency_ms: percentileOf(all, 0.95),
    latency_by_tool,
  };
}

/** Filas `{..., c30, c7, c1}` de una consulta con tres cortes -> lista ordenada de una ventana, sin ceros. */
function windowedList<K extends string>(
  rows: readonly (Record<"c30" | "c7" | "c1", number> & Record<K, string>)[],
  key: K,
  col: "c30" | "c7" | "c1",
  limit?: number
): Array<Record<K, string> & { calls: number }> {
  const out = rows
    .filter((r) => (r[col] ?? 0) > 0)
    .map((r) => ({ [key]: r[key], calls: r[col] }) as Record<K, string> & { calls: number })
    .sort((a, b) => b.calls - a.calls);
  return limit ? out.slice(0, limit) : out;
}

/** Fase 25.15 — clase de una fila de "Recent errors" (ver LoggedFailureClass). */
export function loggedFailureClass(type: string, detail: string | null): LoggedFailureClass {
  if (type === "tool_error") return classifyToolError(detail);
  if (MONEY_FAILURE_TYPES.has(type)) return "money";
  return "payment";
}

async function computeDashboardData(
  db: D1Database,
  includeInternal: boolean
): Promise<DashboardData> {
  const now = Date.now();
  const since30 = now - MS_30D;
  const since365 = now - MS_365D;
  const since7 = now - MS_7D;
  const since1 = now - MS_24H;
  /** Orden fijo de las ventanas en cada consulta con tres cortes: 30 d (la propia WHERE), 7 d, 24 h. */
  const WINDOW_SINCE: Record<WindowKey, number> = { d30: since30, d7: since7, h24: since1 };
  const WINDOW_COL: Record<WindowKey, "c30" | "c7" | "c1"> = { d30: "c30", d7: "c7", h24: "c1" };
  // Own dev/testing traffic (internal = 1) is excluded by default — the panel
  // measures real external demand. Directory/registry probes (Fase 24.6) are
  // bundled into the same toggle: real signal is what ?include_internal=1
  // is for, and a probe scraping the catalog isn't demand either. Constant
  // string, never user input.
  const internalFilter = includeInternal
    ? ""
    : ` AND internal = 0${NON_PROBE_SQL}`;

  const [
    summary,
    topTools,
    payBreakdown,
    creditPurchasesSummary,
    creditPurchases,
    creditLiability,
    callsSeries,
    revSeries,
    callsHalfhour,
    revenueHalfhour,
    anonAgents,
    returningAgents,
    recentErrors,
    totalByTool,
    errorRows,
    latencyRows,
    connectsByClient,
    callsByClient,
    revenueByClient,
    sessionRows,
    directoryCoverage,
    directoryStatsLatest,
    smitheryUseCountSeries,
    paywallFunnels,
    oldestEvent,
  ] = await Promise.all([
      // Fase 25.15 — tres cortes sobre las mismas filas (ver WindowKey).
      // payers = identificados (wallet/cuenta); los anonimos van aparte.
      db
        .prepare(
          `SELECT count(*) AS c30, SUM(ts >= ?) AS c7, SUM(ts >= ?) AS c1,
                  COALESCE(sum(CASE WHEN payment_type NOT IN (${DEPOSIT_TYPES_SQL}) THEN revenue_usdc ELSE 0 END), 0) AS r30,
                  COALESCE(sum(CASE WHEN ts >= ? AND payment_type NOT IN (${DEPOSIT_TYPES_SQL}) THEN revenue_usdc ELSE 0 END), 0) AS r7,
                  COALESCE(sum(CASE WHEN ts >= ? AND payment_type NOT IN (${DEPOSIT_TYPES_SQL}) THEN revenue_usdc ELSE 0 END), 0) AS r1,
                  count(DISTINCT CASE WHEN payer NOT LIKE 'anon%' THEN payer END) AS p30,
                  count(DISTINCT CASE WHEN ts >= ? AND payer NOT LIKE 'anon%' THEN payer END) AS p7,
                  count(DISTINCT CASE WHEN ts >= ? AND payer NOT LIKE 'anon%' THEN payer END) AS p1
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}`
        )
        .bind(since7, since1, since7, since1, since7, since1, since30)
        .first<{ c30: number; c7: number; c1: number; r30: number; r7: number; r1: number; p30: number; p7: number; p1: number }>(),

      db
        .prepare(
          `SELECT tool_name AS tool, count(*) AS c30, SUM(ts >= ?) AS c7, SUM(ts >= ?) AS c1
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY tool_name`
        )
        .bind(since7, since1, since30)
        .all<{ tool: string; c30: number; c7: number; c1: number }>(),

      // 402_rejected is split into a benign "no wallet yet" handshake
      // (detail = no_payment_payload) vs. a real payment-verification failure,
      // so the panel doesn't conflate normal x402 discovery with lost revenue.
      // "connect" (Fase 24, one per MCP initialize) is a connection event, not
      // a tool-call payment outcome — excluded from this chart too.
      db
        .prepare(
          `SELECT
             CASE
               WHEN payment_type = '402_rejected' AND (detail IS NULL OR detail = 'no_payment_payload')
                 THEN '402_no_wallet'
               WHEN payment_type = '402_rejected'
                 THEN '402_pay_failed'
               ELSE payment_type
             END AS type,
             count(*) AS c30, SUM(ts >= ?) AS c7, SUM(ts >= ?) AS c1
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY type`
        )
        .bind(since7, since1, since30)
        .all<{ type: string; c30: number; c7: number; c1: number }>(),

      // Fase 24.7 — cash purchases split by rail. Replays (Polar webhook
      // redelivery, guarded by polar_orders PK — see index.ts) log
      // revenue_usdc = 0 with detail starting "replay", excluded here so a
      // retried delivery doesn't inflate the purchase count.
      db
        .prepare(
          `SELECT CASE WHEN payment_type = 'fiat_deposit_success' THEN 'fiat' ELSE 'crypto' END AS rail,
                  count(*) AS cnt,
                  COALESCE(sum(revenue_usdc), 0) AS total
           FROM analytics_events
           WHERE payment_type IN (${DEPOSIT_TYPES_SQL})
             AND ts >= ? AND (detail IS NULL OR detail NOT LIKE 'replay%')${internalFilter}
           GROUP BY rail`
        )
        .bind(since30)
        .all<{ rail: "crypto" | "fiat"; cnt: number; total: number }>(),

      // Fase 24.7 — individual purchase log, both rails, wider window (cash
      // events are rare and valuable — 30d would hide most of them).
      db
        .prepare(
          `SELECT ts, payment_type AS type, payer, revenue_usdc AS amount, detail
           FROM analytics_events
           WHERE payment_type IN (${DEPOSIT_TYPES_SQL}) AND ts >= ?${internalFilter}
           ORDER BY ts DESC
           LIMIT 100`
        )
        .bind(since365)
        .all<{ ts: number; type: string; payer: string; amount: number; detail: string | null }>(),

      // Fase 24.7 — credit liability straight from the source-of-truth
      // balances table (see migrations/0001_prepaid.sql), not derived from
      // events: outstanding = money already charged but not yet consumed.
      db
        .prepare(
          `SELECT COALESCE(sum(balance_micro), 0) / 1e6 AS outstanding,
                  COALESCE(sum(total_deposited_micro), 0) / 1e6 AS lifetime_purchased,
                  COALESCE(sum(total_spent_micro), 0) / 1e6 AS lifetime_consumed,
                  count(*) AS accounts
           FROM balances`
        )
        .first<{ outstanding: number; lifetime_purchased: number; lifetime_consumed: number; accounts: number }>(),

      // Calls per day — aggregate in JS from raw ts+count bucketed rows.
      // Up to 365 days of daily granularity; the panel re-buckets client-side
      // for wider timeframes so the timeframe selector never re-fetches.
      db
        .prepare(
          `SELECT ts, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since365)
        .all<{ ts: number; calls: number }>(),

      // Fase 24.7 — usage revenue only; deposit/purchase cash-in is reported
      // separately via `credits` (see summary.revenue_30d comment above).
      db
        .prepare(
          `SELECT ts, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect' AND payment_type NOT IN (${DEPOSIT_TYPES_SQL})${internalFilter}
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since365)
        .all<{ ts: number; revenue: number }>(),

      // Fase 24.7 — 30-minute buckets over 7 days for the intraday chart
      // views (TradingView-style 30m/1h/4h); the panel re-buckets client-side
      // from this one fetch, same pattern as the daily series above.
      db
        .prepare(
          `SELECT (ts / 1800000) * 1800000 AS bucket, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY (ts / 1800000)
           ORDER BY bucket ASC`
        )
        .bind(since7)
        .all<{ bucket: number; calls: number }>(),

      db
        .prepare(
          `SELECT (ts / 1800000) * 1800000 AS bucket, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect' AND payment_type NOT IN (${DEPOSIT_TYPES_SQL})${internalFilter}
           GROUP BY (ts / 1800000)
           ORDER BY bucket ASC`
        )
        .bind(since7)
        .all<{ bucket: number; revenue: number }>(),

      // Fase 25.1 (fixed 2026-07-18) — distinct anonymous agents. Two
      // opposing distortions to correct at once: (a) the Anthropic egress
      // rotates IPs *within one MCP session*, so one agent logs several
      // anon:<hash> payers (session 477838cd…, 2026-07-17: one Claude agent,
      // 4 payers); (b) one agent opens MANY sessions (a scanner opened ~40
      // in a minute), so grouping by session — the first 25.1 attempt —
      // counted sessions, not agents, and reported 1.4k where there were 5.
      // Fix: two-step canonicalization. Each session gets an anchor
      // (MIN(payer) within it); each payer canonicalizes to the smallest
      // anchor across its sessions. A payer with N sessions stays 1 agent;
      // payers sharing a session collapse into 1. Sessionless rows fall back
      // to the raw payer.
      // Fase 25.15 — el mapa de identidades se construye sobre 30 d y cada
      // ventana cuenta los agentes canonicos con algun evento en ella.
      db
        .prepare(
          `WITH ev AS (
             SELECT payer, NULLIF(session_id, '') AS sid, ts
             FROM analytics_events
             WHERE ts >= ? AND payment_type != 'connect' AND payer LIKE 'anon:%'${internalFilter}
           ),
           anchors AS (
             SELECT sid, MIN(payer) AS anchor FROM ev WHERE sid IS NOT NULL GROUP BY sid
           ),
           canon AS (
             SELECT p.payer, COALESCE(MIN(a.anchor), p.payer) AS canon
             FROM (SELECT DISTINCT payer, sid FROM ev) p
             LEFT JOIN anchors a ON p.sid = a.sid
             GROUP BY p.payer
           )
           SELECT count(DISTINCT c.canon) AS c30,
                  count(DISTINCT CASE WHEN ev.ts >= ? THEN c.canon END) AS c7,
                  count(DISTINCT CASE WHEN ev.ts >= ? THEN c.canon END) AS c1
           FROM ev JOIN canon c ON ev.payer = c.payer`
        )
        .bind(since30, since7, since1)
        .first<{ c30: number; c7: number; c1: number }>(),

      // Fase 24.7 — retention: distinct payers (excluding the legacy 'anon'
      // literal; anon:<hash> pseudonyms count) seen both this week and last.
      // Fase 25.1 (fixed 2026-07-18) — the first 25.1 attempt grouped by
      // session on each side of the INTERSECT, which made agent identities
      // session-local and never comparable across weeks (returning dropped
      // to 0). Fix: compute the same two-step canonicalization as anonAgents
      // over the FULL 14-day window (so both weeks share one identity map),
      // then intersect the per-week canonical-agent sets. Still not perfect:
      // an agent whose anchor IP hash changes between weeks with no shared
      // session won't match — acceptable residual for a pseudonymous metric.
      db
        .prepare(
          `WITH ev AS (
             SELECT payer, NULLIF(session_id, '') AS sid, ts
             FROM analytics_events
             WHERE ts >= ? AND payment_type != 'connect' AND payer != 'anon'${internalFilter}
           ),
           anchors AS (
             SELECT sid, MIN(payer) AS anchor FROM ev WHERE sid IS NOT NULL GROUP BY sid
           ),
           canon AS (
             SELECT p.payer, COALESCE(MIN(a.anchor), p.payer) AS canon
             FROM (SELECT DISTINCT payer, sid FROM ev) p
             LEFT JOIN anchors a ON p.sid = a.sid
             GROUP BY p.payer
           )
           SELECT count(*) AS n FROM (
             SELECT DISTINCT c.canon FROM ev JOIN canon c ON ev.payer = c.payer WHERE ev.ts >= ?
             INTERSECT
             SELECT DISTINCT c.canon FROM ev JOIN canon c ON ev.payer = c.payer WHERE ev.ts < ?
           )`
        )
        .bind(now - 2 * MS_7D, since7, since7)
        .first<{ n: number }>(),

      // Fase 25.15 — el log de fallos: sin el handshake 402 sin wallet (es
      // Payment mix), con client_name ademas del UA crudo.
      db
        .prepare(
          `SELECT ts, tool_name AS tool, payment_type AS type, payer, client_name, client, detail
           FROM analytics_events
           WHERE ts >= ? AND payment_type IN (${LOGGED_FAILURE_TYPES_SQL})
             AND NOT (payment_type = '402_rejected' AND (detail IS NULL OR detail = 'no_payment_payload'))${internalFilter}
           ORDER BY ts DESC
           LIMIT 200`
        )
        .bind(since30)
        .all<{
          ts: number;
          tool: string;
          type: string;
          payer: string;
          client_name: string | null;
          client: string | null;
          detail: string | null;
        }>(),

      // total calls per tool (error-rate denominator) — kept as a separate
      // lightweight query so errorRows below only has to fetch error rows,
      // not a full table scan.
      db
        .prepare(
          // Fase 25.8 — es el denominador del error_pct por tool, y el
          // numerador (errorRows) son solo tool_error, jamas un connect. Los
          // connect ademas van todos con tool_name = 'initialize', un bucket
          // propio que nadie consulta aqui: filtrarlos no altera ningun
          // porcentaje y permite usar idx_ae_noconnect_ts en vez de escanear
          // la tabla entera.
          `SELECT tool_name AS tool, count(*) AS c30, SUM(ts >= ?) AS c7, SUM(ts >= ?) AS c1
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY tool_name`
        )
        .bind(since7, since1, since30)
        .all<{ tool: string; c30: number; c7: number; c1: number }>(),

      // Fase 24.6 / 25.15 — raw tool_error rows so isPagedToolError (shared
      // with error-alerts.ts) classifies each one in JS instead of
      // duplicating that regex/string logic as SQL LIKE patterns. SOLO
      // tool_error: durante un mes esta consulta traia todos los tipos de
      // pago y classifyToolError("no_payment_payload") caia en "internal",
      // asi que el panel pinto 59 fallos "nuestros" en 30 d que eran el
      // handshake normal de x402, mientras el pager sonaba 0 veces.
      db
        .prepare(
          `SELECT ts, tool_name AS tool, detail, payer, client_name, client
           FROM analytics_events
           WHERE ts >= ? AND payment_type = 'tool_error'${internalFilter}
           ORDER BY ts DESC
           LIMIT 20000`
        )
        .bind(since30)
        .all<ErrorRowIn>(),

      // Fase 24.6 — raw per-call latency rows for the per-tool p50/p95
      // breakdown below (computed in JS, same bounded-fetch pattern as the
      // session funnel). Fase 25.8: el p50/p95 GLOBAL sale tambien de aqui
      // (antes eran 4 consultas SQL aparte, la peor del panel). Fase 25.15:
      // con ts, para cortar por ventana en JS.
      db
        .prepare(
          `SELECT ts, tool_name AS tool, latency_ms
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect' AND latency_ms > 0${internalFilter}
           ORDER BY ts DESC
           LIMIT 20000`
        )
        .bind(since30)
        .all<{ ts: number; tool: string; latency_ms: number }>(),

      // NOTE: GROUP BY the raw COALESCE(...) expression, not its output alias
      // ("client") — grouping by the alias mis-collapses rows in D1's SQLite
      // (verified: all rows landed in one bucket keyed by the first row's
      // value). Grouping by the full expression is correct and reproducible.
      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
           FROM analytics_events
           WHERE ts >= ? AND payment_type = 'connect'${internalFilter}
           GROUP BY COALESCE(client_name, 'unknown')
           ORDER BY connects DESC`
        )
        .bind(since30)
        .all<{ client: string; connects: number }>(),

      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS c30, SUM(ts >= ?) AS c7, SUM(ts >= ?) AS c1
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY COALESCE(client_name, 'unknown')`
        )
        .bind(since7, since1, since30)
        .all<{ client: string; c30: number; c7: number; c1: number }>(),

      db
        .prepare(
          // Fase 25.8 — `payment_type != 'connect'` no cambia NADA del
          // resultado (los eventos connect se registran siempre con
          // revenue_usdc = 0, verificado en produccion) y el panel lee esto
          // como lookup `revenue.get(client) ?? 0` sobre una lista de
          // clientes que sale de connects_by_client + funnel, nunca de aqui.
          // Lo que si cambia es el coste: sin ese termino la consulta no
          // puede usar idx_ae_noconnect_ts y escaneaba la tabla entera.
          `SELECT COALESCE(client_name, 'unknown') AS client, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY COALESCE(client_name, 'unknown')
           ORDER BY revenue DESC`
        )
        .bind(since30)
        .all<{ client: string; revenue: number }>(),

      // Raw per-session rows for the funnel below — session counts are small
      // at this stage of the product, so this is computed in JS rather than
      // a heavier SQL query. Cap protects against an unexpected volume spike.
      db
        .prepare(
          `SELECT session_id, COALESCE(client_name, 'unknown') AS client, tool_name AS tool,
                  payment_type AS type, revenue_usdc AS revenue
           FROM analytics_events
           WHERE ts >= ? AND session_id IS NOT NULL AND payment_type != 'connect'${internalFilter}
           LIMIT 20000`
        )
        .bind(since30)
        .all<{ session_id: string; client: string; tool: string; type: string; revenue: number }>(),

      // Fase 24.6 — directory coverage: the inverse of internalFilter's probe
      // exclusion above. Which known MCP directories/scrapers hit us in the
      // last 7 days, and when last — a listing-health signal, reported on
      // its own rather than folded into (or discarded from) demand metrics.
      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS hits, MAX(ts) AS last_seen
           FROM analytics_events
           WHERE ts >= ? AND internal = 0 AND ${IS_PROBE_SQL}
           GROUP BY COALESCE(client_name, 'unknown')
           ORDER BY last_seen DESC`
        )
        .bind(since7)
        .all<{ client: string; hits: number; last_seen: number }>(),

      // Fase 25.3 — most recent snapshot per directory source (independent of
      // internalFilter/probe exclusion: this table only ever holds our own
      // scheduled snapshots, never caller-driven rows).
      db
        .prepare(
          `SELECT source, use_count, MAX(ts) AS ts
           FROM directory_stats
           GROUP BY source`
        )
        .all<{ source: string; use_count: number | null; ts: number }>(),

      // Fase 25.3 — Smithery useCount series, last 30 days, for the panel chart.
      db
        .prepare(
          `SELECT ts, use_count
           FROM directory_stats
           WHERE source = 'smithery' AND ts >= ? AND use_count IS NOT NULL
           ORDER BY ts ASC`
        )
        .bind(since30)
        .all<{ ts: number; use_count: number }>(),

      paywallFunnelByWindow(db, since30, [since30, since7, since1], internalFilter),

      // Fase 25.15 — desde cuando hay datos (idx_ae_ts: una fila leida).
      db.prepare(`SELECT MIN(ts) AS ts FROM analytics_events`).first<{ ts: number | null }>(),
    ]);

  const s = summary ?? { c30: 0, c7: 0, c1: 0, r30: 0, r7: 0, r1: 0, p30: 0, p7: 0, p1: 0 };
  const liability = creditLiability ?? { outstanding: 0, lifetime_purchased: 0, lifetime_consumed: 0, accounts: 0 };

  // Fase 24.7 — purchases-by-rail rolls up as { crypto, fiat }, defaulting a
  // missing rail to zero (e.g. no fiat purchases in the window at all).
  const purchasedByRail = { crypto: { count: 0, total_usdc: 0 }, fiat: { count: 0, total_usdc: 0 } };
  for (const row of creditPurchasesSummary.results ?? []) {
    purchasedByRail[row.rail] = { count: row.cnt, total_usdc: row.total };
  }

  // Fase 24 — per-session funnel: connect -> >=1 call -> >=3 calls in one
  // family -> paid. Grouped by session_id first (a session belongs to one
  // client), then rolled up per client.
  interface SessionAgg {
    client: string;
    familyCounts: Record<string, number>;
    paid: boolean;
  }
  const sessions = new Map<string, SessionAgg>();
  for (const row of sessionRows.results ?? []) {
    let agg = sessions.get(row.session_id);
    if (!agg) {
      agg = { client: row.client, familyCounts: {}, paid: false };
      sessions.set(row.session_id, agg);
    }
    for (const familyId of TOOL_FAMILIES[row.tool] ?? []) {
      agg.familyCounts[familyId] = (agg.familyCounts[familyId] ?? 0) + 1;
    }
    if (row.revenue > 0) agg.paid = true;
  }
  const funnelByClient = new Map<
    string,
    { sessions: number; sessions_with_call: number; sessions_family_complete: number; sessions_paid: number }
  >();
  for (const agg of sessions.values()) {
    const bucket = funnelByClient.get(agg.client) ?? {
      sessions: 0,
      sessions_with_call: 0,
      sessions_family_complete: 0,
      sessions_paid: 0,
    };
    bucket.sessions += 1;
    const totalCalls = Object.values(agg.familyCounts).reduce((a, b) => a + b, 0);
    if (totalCalls >= 1) bucket.sessions_with_call += 1;
    if (Object.values(agg.familyCounts).some((n) => n >= 3)) bucket.sessions_family_complete += 1;
    if (agg.paid) bucket.sessions_paid += 1;
    funnelByClient.set(agg.client, bucket);
  }

  // Fase 25.15 — una WindowStats por corte, todas de las mismas filas.
  const toolRows = topTools.results ?? [];
  const payRows = payBreakdown.results ?? [];
  const clientRows = callsByClient.results ?? [];
  const totalRows = totalByTool.results ?? [];
  const errRows = errorRows.results ?? [];
  const latRows = latencyRows.results ?? [];
  const funnelByWindow: Record<WindowKey, { hit_payers: number; converted_payers: number }> = {
    d30: paywallFunnels[0],
    d7: paywallFunnels[1],
    h24: paywallFunnels[2],
  };
  const sumCol = { d30: { c: s.c30, r: s.r30, p: s.p30 }, d7: { c: s.c7, r: s.r7, p: s.p7 }, h24: { c: s.c1, r: s.r1, p: s.p1 } };
  const anonCol = { d30: anonAgents?.c30 ?? 0, d7: anonAgents?.c7 ?? 0, h24: anonAgents?.c1 ?? 0 };
  const byWindow = {} as Record<WindowKey, WindowStats>;
  for (const w of WINDOW_KEYS) {
    const col = WINDOW_COL[w];
    const since = WINDOW_SINCE[w];
    const totals = new Map(totalRows.map((r) => [r.tool, r[col] ?? 0]));
    byWindow[w] = {
      calls: sumCol[w].c ?? 0,
      revenue: sumCol[w].r ?? 0,
      unique_payers: sumCol[w].p ?? 0,
      unique_anon_agents: anonCol[w],
      ...rollupLatency(latRows, since),
      top_tools: windowedList(toolRows, "tool", col, 10),
      payment_breakdown: windowedList(payRows, "type", col),
      calls_by_client: windowedList(clientRows, "client", col),
      paywall_funnel: funnelByWindow[w],
      error_rate_by_tool: rollupErrorRates(errRows, totals, since),
    };
  }
  const d30 = byWindow.d30;

  return {
    summary: {
      calls_30d: d30.calls,
      revenue_30d: d30.revenue,
      unique_payers_30d: d30.unique_payers,
      unique_anon_agents_30d: d30.unique_anon_agents,
      returning_agents_7d: returningAgents?.n ?? 0,
      avg_latency_ms: d30.avg_latency_ms,
      p50_latency_ms: d30.p50_latency_ms,
      p95_latency_ms: d30.p95_latency_ms,
    },
    calls_by_day: (callsSeries.results ?? []).map((r) => ({
      day: dayLabel(r.ts),
      calls: r.calls,
    })),
    revenue_by_day: (revSeries.results ?? []).map((r) => ({
      day: dayLabel(r.ts),
      revenue: r.revenue,
    })),
    calls_by_halfhour: (callsHalfhour.results ?? []).map((r) => ({ ts: r.bucket, calls: r.calls })),
    revenue_by_halfhour: (revenueHalfhour.results ?? []).map((r) => ({ ts: r.bucket, revenue: r.revenue })),
    top_tools: d30.top_tools,
    payment_breakdown: d30.payment_breakdown,
    credits: {
      purchased_30d: purchasedByRail,
      outstanding_usdc: liability.outstanding,
      lifetime_purchased_usdc: liability.lifetime_purchased,
      lifetime_consumed_usdc: liability.lifetime_consumed,
      accounts: liability.accounts,
    },
    credit_purchases: creditPurchases.results ?? [],
    recent_errors: (recentErrors.results ?? []).map((r) => ({
      ...r,
      class: loggedFailureClass(r.type, r.detail),
      paged: isPagedToolError({
        paymentType: r.type,
        detail: r.detail,
        payer: r.payer,
        clientName: r.client_name,
        client: r.client,
      }),
    })),
    error_rate_by_tool: d30.error_rate_by_tool,
    latency_by_tool: d30.latency_by_tool,
    directory_coverage: directoryCoverage.results ?? [],
    directory_stats: directoryStatsLatest.results ?? [],
    smithery_use_count_series: (smitheryUseCountSeries.results ?? []).map((r) => ({
      day: dayLabel(r.ts),
      use_count: r.use_count,
    })),
    paywall_funnel: d30.paywall_funnel,
    surface: {
      connects_by_client: connectsByClient.results ?? [],
      calls_by_client: d30.calls_by_client,
      revenue_by_client: revenueByClient.results ?? [],
      funnel_by_client: Array.from(funnelByClient.entries()).map(([client, f]) => ({ client, ...f })),
    },
    by_window: byWindow,
    retention: {
      events_days: ANALYTICS_RETENTION_DAYS,
      connect_days: CONNECT_RETENTION_DAYS,
      oldest_event_ts: oldestEvent?.ts ?? null,
    },
  };
}

export interface WeeklySurfaceDigest {
  connects_this_week: Array<{ client: string; connects: number }>;
  connects_last_week: Array<{ client: string; connects: number }>;
  calls_this_week: Array<{ client: string; calls: number }>;
  total_calls_this_week: number;
  total_calls_last_week: number;
  total_revenue_this_week: number;
  top_tools_this_week: Array<{ tool: string; calls: number }>;
  /** free-tier tool calls that converted into a paid call, this week (x402/prepaid/api_key, excluding rejections). */
  paid_calls_this_week: number;
  /** Fase 24.6 — paywall-hit-to-conversion signal, this week (see getDashboardData's paywall_funnel). */
  paywall_funnel_this_week: { hit_payers: number; converted_payers: number };
  /**
   * Fase 25.3 — directory-listing stats: current snapshot per source, the
   * snapshot closest to 7 days ago (for a week-over-week delta), and whether
   * the listing description changed since the last snapshot (a drift signal
   * — the description is edited by hand on each directory's site, so a
   * silent change deserves a look).
   */
  directory_stats: Array<{
    source: string;
    use_count: number | null;
    use_count_7d_ago: number | null;
    description_changed: boolean;
  }>;
  /**
   * Fase 25.9 — el ruido que el pager ya NO manda, contado una vez por semana.
   * El movil deja de vibrar por estas cosas, pero el volumen sigue siendo
   * informacion: si `caller` se dispara en una tool concreta es que su esquema
   * confunde a los agentes, y si `internal` no es cero es que hubo alertas
   * reales que revisar en el panel.
   */
  suppressed_errors_this_week: { caller: number; upstream: number; internal: number; probe: number };
}

/**
 * Data for the Telegram weekly digest (Fase 24.3) — this week vs last week,
 * by surface (client_name). Excludes internal traffic unconditionally (the
 * digest reports on real external demand, same default as the panel).
 */
export async function getWeeklySurfaceDigest(db: D1Database, now = Date.now()): Promise<WeeklySurfaceDigest> {
  const startThisWeek = now - MS_7D;
  const startLastWeek = now - 2 * MS_7D;

  // Fase 25.15 — misma definicion de "pagado" que el panel y el pager
  // (payment-types.ts). La lista local de aqui omitia oauth.
  const paidPlaceholders = PAID_TYPES.map(() => "?").join(",");

  // Same "real external demand" notion as the panel: no internal traffic,
  // no directory-probe scrapers (Fase 24.6) — otherwise the digest's
  // connects/calls tables stay dominated by glimind-probe & friends.
  const digestFilter = ` AND internal = 0${NON_PROBE_SQL}`;

  const [connectsThis, connectsLast, callsThis, revThis, topTools, paidThis] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
         FROM analytics_events
         WHERE ts >= ? AND payment_type = 'connect'${digestFilter}
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY connects DESC`
      )
      .bind(startThisWeek)
      .all<{ client: string; connects: number }>(),

    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
         FROM analytics_events
         WHERE ts >= ? AND ts < ? AND payment_type = 'connect'${digestFilter}
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY connects DESC`
      )
      .bind(startLastWeek, startThisWeek)
      .all<{ client: string; connects: number }>(),

    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS calls
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect'${digestFilter}
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY calls DESC`
      )
      .bind(startThisWeek)
      .all<{ client: string; calls: number }>(),

    db
      .prepare(
        `SELECT count(*) AS calls_this, COALESCE(sum(revenue_usdc), 0) AS revenue
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect'${digestFilter}`
      )
      .bind(startThisWeek)
      .first<{ calls_this: number; revenue: number }>(),

    db
      .prepare(
        `SELECT tool_name AS tool, count(*) AS calls
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect'${digestFilter}
         GROUP BY tool_name
         ORDER BY calls DESC
         LIMIT 5`
      )
      .bind(startThisWeek)
      .all<{ tool: string; calls: number }>(),

    db
      .prepare(
        `SELECT count(*) AS n FROM analytics_events
         WHERE ts >= ?${digestFilter} AND payment_type IN (${paidPlaceholders})`
      )
      .bind(startThisWeek, ...PAID_TYPES)
      .first<{ n: number }>(),
  ]);

  const [lastWeekTotal, paywallFunnelThisWeek, weekErrorRows, directoryStatsRows] = await Promise.all([
    db
      .prepare(
        `SELECT count(*) AS n FROM analytics_events
         WHERE ts >= ? AND ts < ? AND payment_type != 'connect'${digestFilter}`
      )
      .bind(startLastWeek, startThisWeek)
      .first<{ n: number }>(),
    paywallConversionFunnel(db, startThisWeek, digestFilter),
    // Fase 25.9 — TODOS los tool_error de la semana (incluidos los de
    // escaneres, a diferencia del resto del digest: aqui el objetivo es medir
    // el ruido que se ha silenciado, no la demanda real). Se clasifican en JS
    // con el mismo clasificador que usa el pager.
    db
      .prepare(
        `SELECT detail, client_name, client FROM analytics_events
         WHERE ts >= ? AND payment_type = 'tool_error' AND internal = 0
         LIMIT 20000`
      )
      .bind(startThisWeek)
      .all<{ detail: string | null; client_name: string | null; client: string | null }>(),
    // Fase 25.3 — last 40 days of every directory snapshot (2 rows/day, so
    // this is always a tiny result set), newest first per source. Latest,
    // previous, and "closest to 7 days ago" are all derived in JS below,
    // same style as the errorAgg/latencyByTool rollups above.
    db
      .prepare(
        `SELECT source, ts, use_count, listing FROM directory_stats
         WHERE ts >= ?
         ORDER BY source ASC, ts DESC`
      )
      .bind(now - 40 * 24 * 60 * 60 * 1000)
      .all<{ source: string; ts: number; use_count: number | null; listing: string | null }>(),
  ]);

  const rowsBySource = new Map<string, Array<{ ts: number; use_count: number | null; listing: string | null }>>();
  for (const row of directoryStatsRows.results ?? []) {
    const arr = rowsBySource.get(row.source) ?? [];
    arr.push(row); // already ordered newest-first by the query above
    rowsBySource.set(row.source, arr);
  }
  const listingDescription = (listing: string | null): string | null => {
    if (!listing) return null;
    try {
      return (JSON.parse(listing) as { description?: string }).description ?? null;
    } catch {
      return null;
    }
  };
  const directoryStatsOut = Array.from(rowsBySource.entries()).map(([source, rows]) => {
    const latest = rows[0];
    const previous = rows[1];
    const sevenDaysAgo = rows.find((r) => r.ts <= startThisWeek) ?? null;
    return {
      source,
      use_count: latest.use_count,
      use_count_7d_ago: sevenDaysAgo?.use_count ?? null,
      description_changed: previous ? listingDescription(latest.listing) !== listingDescription(previous.listing) : false,
    };
  });

  const suppressed = { caller: 0, upstream: 0, internal: 0, probe: 0 };
  for (const row of weekErrorRows.results ?? []) {
    if (isProbeClient(row.client_name, row.client)) {
      suppressed.probe += 1;
      continue;
    }
    suppressed[classifyToolError(row.detail)] += 1;
  }

  return {
    connects_this_week: connectsThis.results ?? [],
    connects_last_week: connectsLast.results ?? [],
    calls_this_week: callsThis.results ?? [],
    total_calls_this_week: revThis?.calls_this ?? 0,
    total_calls_last_week: lastWeekTotal?.n ?? 0,
    total_revenue_this_week: revThis?.revenue ?? 0,
    top_tools_this_week: topTools.results ?? [],
    paid_calls_this_week: paidThis?.n ?? 0,
    paywall_funnel_this_week: paywallFunnelThisWeek,
    directory_stats: directoryStatsOut,
    suppressed_errors_this_week: suppressed,
  };
}
