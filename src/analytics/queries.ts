/**
 * D1 queries for the analytics dashboard (/analytics/data endpoint).
 * All queries run against the analytics_events table (migration 0002).
 */

import { FAMILIES } from "../tools/catalog.js";
import { PROBE_CLIENTS, PROBE_NAME_PATTERNS, PROBE_UA_PATTERNS, isProbeClient } from "./surface.js";
import { classifyToolError, isPagedToolError, type ToolErrorClass } from "../alerts/error-classification.js";
import { PAID_TYPES, PAID_TYPES_SQL, DEPOSIT_TYPES_SQL } from "./payment-types.js";
import { ANALYTICS_RETENTION_DAYS, CONNECT_RETENTION_DAYS } from "./retention.js";
import { findBrokenTools, loadHealthWindow, canaryFor, brokenToolPages, type BrokenTool, type CanaryFetch, type CanaryResult } from "../alerts/health.js";
import { readCronStatuses, type CronStatus } from "../alerts/cron-status.js";
import { cogsList, EXECUTED_SQL, type CogsRow, type ToolCogsRow } from "./cogs.js";

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_365D = 365 * 24 * 60 * 60 * 1000;

/**
 * MCP directory/registry scrapers (see surface.ts PROBE_CLIENTS) — a fixed
 * constant list, never user input.
 *
 * Fase 25.17 — una cadena `client_name = 'a' OR client_name = 'b' ...` y NO
 * `client_name IN ('a', 'b', ...)`. Equivalentes (mismo resultado, mismo NULL),
 * pero D1 cobra cada comprobacion contra la lista IN como una fila leida
 * mas: medido el 2026-10-20 sobre 5.253 eventos, con IN la consulta lee
 * 10.682 filas y con la cadena OR 5.267 (el resto de variantes —LIKE sueltos,
 * IN de 2 elementos, instr()— no duplicaban). Como este predicado esta en
 * practicamente todas las consultas del panel, es la mitad de sus lecturas.
 */
const PROBE_CLIENTS_SQL = Array.from(PROBE_CLIENTS)
  .map((c) => `client_name = '${c.replace(/'/g, "''")}'`)
  .join(" OR ");

/**
 * Fase 25.2 — predicate matching probe traffic by exact client_name OR by
 * naming-convention pattern (surface.ts PROBE_NAME_PATTERNS): new scanners
 * appear weekly, so the exact list alone always lags reality. Both constant
 * lists, never user input.
 */
export const IS_PROBE_SQL = `(${PROBE_CLIENTS_SQL} OR ${[
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
export const NON_PROBE_SQL = ` AND NOT COALESCE(${IS_PROBE_SQL}, 0)`;

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

/**
 * Fase 25.17 — ventana de los datos que salen de eventos `connect`
 * (connects_by_client y directory_coverage).
 *
 * Es de 7 d y no de 30 porque los connects son el 80 % de la tabla (27,6 k en
 * 30 d, casi todos de escaneres) y D1 cobra una fila leida por cada connect de
 * la ventana, sea cual sea el indice: no hay forma de contarlos mas barato sin
 * una tabla de resumen. Medido el 2026-10-20: 7 d = 8,2 k connects, 14 d =
 * 16,4 k (ya pasa de los 15 k por consulta que se quiere como techo), 30 d =
 * 27,6 k. 7 d es ademas la ventana de "Directory coverage". El embudo por
 * cliente mantiene sus sesiones a 30 d (salen de eventos no-connect, baratos).
 * El panel lo dice en los titulos.
 */
export const SURFACE_WINDOW_DAYS = 7;

/** Una barra de "Calls by surface": un cliente, partido en real vs escaner (probe). */
export interface ClientCalls {
  client: string;
  calls: number;
  /** true = trafico de directorio/escaner (IS_PROBE_SQL). Las demas tarjetas solo cuentan probe=false. */
  probe: boolean;
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
  calls_by_client: ClientCalls[];
  /** Agentes (no llamadas) que vieron el 402 en la ventana y convirtieron en 7 d, cualquier rail. */
  paywall_funnel: { hit_payers: number; converted_payers: number };
  error_rate_by_tool: ErrorRateRow[];
  latency_by_tool: Array<{ tool: string; calls: number; p50_latency_ms: number; p95_latency_ms: number }>;
  /** Fase 25.18 — COGS estimado por tool (solo tools con COGS > 0 en la ventana; ver cogs.ts). */
  cogs: CogsRow[];
}

/** Fase 25.17 — la franja de estado del panel: lo que esta roto AHORA, no lo que paso en 30 d. */
export interface DashboardHealth {
  /**
   * findBrokenTools sobre la ventana de 6 h, con `paged` = lo que el cron de
   * salud hace con cada una (Fase 25.19: una tool con errores solo del
   * llamante/destino no pagina si el canario llega; sale como nota).
   */
  broken_tools: Array<BrokenTool & { paged: boolean }>;
  /** El fetch de prueba del cron; null si ninguna tool rota lo pidio. */
  canary: CanaryResult | null;
  /** Ultimo evento de cualquier tipo (connect incluido): la senal de silencio del servidor. */
  last_event_ts: number | null;
  crons: CronStatus[];
}

/** Opciones de lectura del panel. `kv` es solo para el estado de los crons; `fresh` salta la cache de 5 min. */
export interface DashboardOptions {
  kv?: KVNamespace;
  fresh?: boolean;
  /** Fase 25.19 — solo tests: sustituye el fetch real del canario. */
  canaryFetch?: CanaryFetch;
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
  retention: { events_days: number; connect_days: number; oldest_event_ts: number | null; surface_days: number };
  /** Fase 25.17 — tools rotas ahora, silencio y estado de cada cron. */
  health: DashboardHealth;
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
   * Fase 25.17 — derived from the same rows as connects_by_client (probe
   * connects in the last 7 d, internal excluded): `hits` are connects now,
   * not every event.
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
    /** Fase 25.17 — connects de los ultimos SURFACE_WINDOW_DAYS (7) d; una fila por (cliente, probe). */
    connects_by_client: Array<{ client: string; connects: number; probe: boolean }>;
    calls_by_client: ClientCalls[];
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
 * Una sola carga de /analytics/data lanza 21 consultas D1 (20 sobre
 * analytics_events/directory_stats y 1 sobre balances) y ~87 k filas leidas
 * (Fase 25.17: eran 25 consultas y ~338 k; ninguna pasa ya de 15 k). Hay dos
 * consumidores mas (/reports/analytics y la rutina de review) y un F5
 * repetido recalculaba todo. 5 min de TTL absorben las rafagas (recargas seguidas, dos pestanas
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
  includeInternal = false,
  opts: DashboardOptions = {}
): Promise<DashboardData> {
  const key = includeInternal ? "internal" : "external";
  const hit = dashboardCache.get(key);
  // Fase 25.17 — `fresh` (el boton ↻ del panel, via /analytics/data?fresh=1)
  // se salta la lectura pero SI escribe la cache: lo recien calculado sirve al
  // siguiente que llegue dentro de los 5 min.
  if (!opts.fresh && hit && Date.now() - hit.at < DASHBOARD_TTL_MS) return hit.data;
  const data = await computeDashboardData(db, includeInternal, opts.kv, opts.canaryFetch);
  dashboardCache.set(key, { at: Date.now(), data });
  return data;
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

/**
 * Fase 25.17 — "Calls by surface" de una ventana: una fila por (cliente, probe),
 * con `probe` para que el panel pinte el tramo real y el de escaner. Misma
 * forma de corte que windowedList (cada consulta lleva c30/c7/c1).
 */
function clientCallsList(
  rows: readonly { client: string; probe: number | null; c30: number; c7: number; c1: number }[],
  col: "c30" | "c7" | "c1"
): ClientCalls[] {
  return rows
    .filter((r) => (r[col] ?? 0) > 0)
    .map((r) => ({ client: r.client, calls: r[col], probe: !!r.probe }))
    .sort((a, b) => b.calls - a.calls);
}

/** Fase 25.15 — clase de una fila de "Recent errors" (ver LoggedFailureClass). */
export function loggedFailureClass(type: string, detail: string | null): LoggedFailureClass {
  if (type === "tool_error") return classifyToolError(detail);
  if (MONEY_FAILURE_TYPES.has(type)) return "money";
  return "payment";
}

/** Redondeo a micro-USDC: la suma en JS no arrastra el ruido de coma flotante (0.1 + 0.2). */
function roundUsdc(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Fase 25.17 — las cuatro series temporales, a partir de las filas
 * `[ts, revenue_usdc, dep]` en orden de ts (una sola lectura, ver la consulta).
 * Mismo resultado que las cuatro consultas GROUP BY que sustituye:
 *  - calls cuenta todas las filas (los depositos tambien son llamadas del
 *    log, como antes); revenue solo las que no son deposito/compra, y un dia
 *    o cubo sin filas de esas simplemente no aparece (el panel rellena con 0).
 *  - dia = floor(ts / 86400000); cubo de media hora = floor(ts / 1800000) * 1800000.
 *  - las de media hora solo cubren los ultimos 7 d.
 */
export function rollupSeries(
  rows: ReadonlyArray<readonly [number, number, number]>,
  since7: number,
  /** Fase B2 — dias anteriores a `rows`, ya agregados: [day 'YYYY-MM-DD', calls, revenue] (analytics_daily). */
  summary: ReadonlyArray<readonly [string, number, number]> = []
): Pick<DashboardData, "calls_by_day" | "revenue_by_day" | "calls_by_halfhour" | "revenue_by_halfhour"> {
  const callsDay = new Map<number, number>();
  const revDay = new Map<number, number>();
  const callsHalf = new Map<number, number>();
  const revHalf = new Map<number, number>();
  for (const [ts, revenue, dep] of rows) {
    const day = Math.floor(ts / 86400000);
    callsDay.set(day, (callsDay.get(day) ?? 0) + 1);
    const recent = ts >= since7;
    const half = Math.floor(ts / 1800000) * 1800000;
    if (recent) callsHalf.set(half, (callsHalf.get(half) ?? 0) + 1);
    if (!dep) {
      revDay.set(day, (revDay.get(day) ?? 0) + revenue);
      if (recent) revHalf.set(half, (revHalf.get(half) ?? 0) + revenue);
    }
  }
  for (const [label, calls, revenue] of summary) {
    const day = Date.parse(label) / 86400000;
    callsDay.set(day, (callsDay.get(day) ?? 0) + calls);
    revDay.set(day, (revDay.get(day) ?? 0) + revenue);
  }
  const byKey = <V>(m: Map<number, V>): Array<[number, V]> => Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  return {
    calls_by_day: byKey(callsDay).map(([d, calls]) => ({ day: dayLabel(d * 86400000), calls })),
    revenue_by_day: byKey(revDay).map(([d, revenue]) => ({ day: dayLabel(d * 86400000), revenue: roundUsdc(revenue) })),
    calls_by_halfhour: byKey(callsHalf).map(([ts, calls]) => ({ ts, calls })),
    revenue_by_halfhour: byKey(revHalf).map(([ts, revenue]) => ({ ts, revenue: roundUsdc(revenue) })),
  };
}

/**
 * Fase 25.17 — connects por (cliente, probe) y la cobertura de directorios, de
 * las MISMAS filas `[client_name, probe, internal, ts]`. directory_coverage era
 * una consulta aparte (21,5 k filas leidas) sobre los mismos eventos: ahora
 * sale de aqui. Cuenta connects de escaner en 7 d, sin trafico interno (el
 * toggle de internos no debe llenar "Directory coverage" con nuestros propios
 * *-audit).
 */
export function rollupConnects(
  rows: ReadonlyArray<readonly [string | null, number, number, number]>,
  since7: number
): { connects_by_client: DashboardData["surface"]["connects_by_client"]; directory_coverage: DashboardData["directory_coverage"] } {
  const byClient = new Map<string, { client: string; probe: boolean; connects: number }>();
  const coverage = new Map<string, { client: string; hits: number; last_seen: number }>();
  for (const [clientName, probe, internal, ts] of rows) {
    const client = clientName ?? "unknown";
    const isProbe = !!probe;
    const key = `${isProbe ? 1 : 0}|${client}`;
    const a = byClient.get(key) ?? { client, probe: isProbe, connects: 0 };
    a.connects += 1;
    byClient.set(key, a);
    if (isProbe && !internal && ts >= since7) {
      const c = coverage.get(client) ?? { client, hits: 0, last_seen: 0 };
      c.hits += 1;
      if (ts > c.last_seen) c.last_seen = ts;
      coverage.set(client, c);
    }
  }
  return {
    connects_by_client: Array.from(byClient.values()).sort((a, b) => b.connects - a.connects),
    directory_coverage: Array.from(coverage.values()).sort((a, b) => b.last_seen - a.last_seen),
  };
}

type AgentRow = readonly [payer: string, sid: string | null, ts: number];

/**
 * Fase 25.17 — identidad canonica de cada payer, como la calculaban las CTE
 * `anchors`/`canon` de SQL: el ancla de una sesion es el MIN(payer) de la
 * sesion; cada payer toma el menor ancla de sus sesiones (o el mismo si no
 * tiene sesion). Comparacion de cadenas igual que SQLite (binaria; los payers
 * son ASCII: wallets, anon:<hash>, acct:...).
 */
export function canonicalAgents(rows: readonly AgentRow[]): Map<string, string> {
  const anchor = new Map<string, string>();
  for (const [payer, sid] of rows) {
    if (sid === null) continue;
    const a = anchor.get(sid);
    if (a === undefined || payer < a) anchor.set(sid, payer);
  }
  const best = new Map<string, string>();
  for (const [payer, sid] of rows) {
    if (sid === null) continue;
    const a = anchor.get(sid) as string;
    const b = best.get(payer);
    if (b === undefined || a < b) best.set(payer, a);
  }
  const canon = new Map<string, string>();
  for (const [payer] of rows) if (!canon.has(payer)) canon.set(payer, best.get(payer) ?? payer);
  return canon;
}

/**
 * Agentes anonimos distintos por ventana (30 d / 7 d / 24 h) y agentes que
 * vuelven (vistos esta semana y la anterior, mapa de identidades sobre 14 d).
 * `rows` son los eventos no-connect de 30 d con payer != 'anon'.
 */
export function rollupAgents(
  rows: readonly AgentRow[],
  since: { d14: number; d7: number; h24: number }
): { anon: { c30: number; c7: number; c1: number }; returning: number } {
  const anonRows = rows.filter(([payer]) => payer.toLowerCase().startsWith("anon:"));
  const anonCanon = canonicalAgents(anonRows);
  const a30 = new Set<string>();
  const a7 = new Set<string>();
  const a1 = new Set<string>();
  for (const [payer, , ts] of anonRows) {
    const c = anonCanon.get(payer) as string;
    a30.add(c);
    if (ts >= since.d7) a7.add(c);
    if (ts >= since.h24) a1.add(c);
  }
  const recent = rows.filter(([, , ts]) => ts >= since.d14);
  const canon = canonicalAgents(recent);
  const thisWeek = new Set<string>();
  const lastWeek = new Set<string>();
  for (const [payer, , ts] of recent) {
    const c = canon.get(payer) as string;
    if (ts >= since.d7) thisWeek.add(c);
    else lastWeek.add(c);
  }
  let returning = 0;
  for (const c of thisWeek) if (lastWeek.has(c)) returning += 1;
  return { anon: { c30: a30.size, c7: a7.size, c1: a1.size }, returning };
}

async function computeDashboardData(
  db: D1Database,
  includeInternal: boolean,
  kv?: KVNamespace,
  canaryFetch?: CanaryFetch
): Promise<DashboardData> {
  const now = Date.now();
  const since30 = now - MS_30D;
  const since365 = now - MS_365D;
  const since7 = now - MS_7D;
  const since1 = now - MS_24H;
  /** Fase B2 — las series crudas empiezan en el inicio del dia UTC de since7; antes, analytics_daily. */
  const rawSeriesFrom = Math.floor(since7 / 86400000) * 86400000;
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
  // Fase 25.17 — las dos consultas que REPARTEN probe vs real (connects y
  // calls por cliente) no excluyen los escaners: devuelven `probe` por fila. El
  // toggle de "trafico interno" sigue mandando sobre internal.
  const internalOnlyFilter = includeInternal ? "" : " AND internal = 0";

  const [
    summary,
    topTools,
    payBreakdown,
    creditPurchasesSummary,
    creditPurchases,
    creditLiability,
    seriesRows,
    seriesDailyRows,
    agentRows,
    recentErrors,
    errorRows,
    latencyRows,
    connectRows,
    callsByClient,
    revenueByClient,
    sessionRows,
    directoryStatsLatest,
    smitheryUseCountSeries,
    paywallFunnels,
    oldestEvent,
    lastEvent,
    healthWindow,
    cronStatuses,
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

      // Fase 25.18 — la misma consulta trae ademas, por tool y ventana, las
      // llamadas EJECUTADAS (las que tocaron al proveedor) y la suma de
      // cogs_usdc registrado: mismas filas leidas, sin consulta nueva (cogs.ts).
      db
        .prepare(
          `SELECT tool_name AS tool,
                  SUM(${EXECUTED_SQL}) AS e30,
                  SUM(ts >= ? AND ${EXECUTED_SQL}) AS e7,
                  SUM(ts >= ? AND ${EXECUTED_SQL}) AS e1,
                  COALESCE(SUM(CASE WHEN ${EXECUTED_SQL} THEN cogs_usdc END), 0) AS g30,
                  COALESCE(SUM(CASE WHEN ts >= ? AND ${EXECUTED_SQL} THEN cogs_usdc END), 0) AS g7,
                  COALESCE(SUM(CASE WHEN ts >= ? AND ${EXECUTED_SQL} THEN cogs_usdc END), 0) AS g1,
                  count(*) AS c30, SUM(ts >= ?) AS c7, SUM(ts >= ?) AS c1
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY tool_name`
        )
        .bind(since7, since1, since7, since1, since7, since1, since30)
        .all<{ tool: string; c30: number; c7: number; c1: number } & ToolCogsRow>(),

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

      // Fase 25.17 — UNA consulta para las cuatro series temporales; Fase B2 —
      // ya no a 365 d. Las filas crudas (en orden de ts por el indice cubriente
      // idx_ae_noconnect_cover, sin sorter ni salto a la tabla) cubren desde el
      // inicio del dia UTC de since7 (<= 8 dias, ~2,3 k filas): las dos series de
      // media hora (7 d) y los ultimos dias completos de calls/revenue por dia,
      // con el dia en curso siempre al dia. El resto de calls_by_day /
      // revenue_by_day sale de analytics_daily (query de abajo). Los cubos se
      // hacen en JS (rollupSeries). `.raw()` devuelve arrays.
      db
        .prepare(
          `SELECT ts, revenue_usdc, payment_type IN (${DEPOSIT_TYPES_SQL}) AS dep
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           ORDER BY ts ASC`
        )
        .bind(rawSeriesFrom)
        .raw<[number, number, number]>(),

      // Fase B2 — dias de 365 d hasta el inicio de las filas crudas, del resumen
      // diario (rellena el cron: src/analytics/daily.ts). Como mucho 4 filas por
      // dia (internal x probe); el toggle decide cuales: por defecto solo
      // internal = 0 y probe = 0, igual que internalFilter.
      db
        .prepare(
          `SELECT day, calls, revenue_usdc
           FROM analytics_daily
           WHERE day >= ? AND day < ?${includeInternal ? "" : " AND internal = 0 AND probe = 0"}`
        )
        .bind(dayLabel(since365), dayLabel(rawSeriesFrom))
        .raw<[string, number, number]>(),

      // Fase 25.1 (fixed 2026-07-18) — distinct anonymous agents, and Fase
      // 24.7 retention (agents seen both this week and last). Two opposing
      // distortions to correct at once: (a) the Anthropic egress rotates IPs
      // *within one MCP session*, so one agent logs several anon:<hash>
      // payers (session 477838cd…, 2026-07-17: one Claude agent, 4 payers);
      // (b) one agent opens MANY sessions (a scanner opened ~40 in a minute),
      // so grouping by session — the first 25.1 attempt — counted sessions,
      // not agents, and reported 1.4k where there were 5. Fix: two-step
      // canonicalization (see canonicalAgents): each session gets an anchor
      // (MIN(payer) within it); each payer canonicalizes to the smallest
      // anchor across its sessions. Sessionless rows fall back to the raw payer.
      //
      // Fase 25.17 — ese calculo vivia en dos CTE de SQL (anonAgents y
      // returningAgents: 32 k y 9 k filas leidas) que re-evaluaban la misma
      // CTE tres veces cada una. Ahora es UNA lectura de (payer, sesion, ts) de
      // 30 d (~5 k filas) y la canonicalizacion se hace en JS, con el mismo
      // resultado (verificado contra D1 real: c30/c7/c1 y n identicos).
      db
        .prepare(
          `SELECT payer, NULLIF(session_id, '') AS sid, ts
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect' AND payer != 'anon'${internalFilter}`
        )
        .bind(since30)
        .raw<[string, string | null, number]>(),

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

      // Fase 25.17 — connects por cliente, con `probe` por fila en vez de
      // excluir los escaners. Se agrupa en JS (rollupConnects), no con GROUP BY:
      // el GROUP BY de SQLite metia cada connect en un temp B-tree (x2 filas
      // leidas) y la ventana de 30 d son 27,6 k connects. Ahora el indice
      // cubriente idx_ae_pay_int_ts_cn_ua (payment_type, internal, ts,
      // client_name, client) los entrega en orden sin tocar la tabla: 1 fila
      // por connect de la ventana de SURFACE_WINDOW_DAYS. LIMIT de seguridad
      // ante una avalancha de un escaner (hoy ~13 k).
      db
        .prepare(
          `SELECT client_name, COALESCE(${IS_PROBE_SQL}, 0) AS probe, internal, ts
           FROM analytics_events
           WHERE ts >= ? AND payment_type = 'connect'${internalOnlyFilter}
           LIMIT 50000`
        )
        .bind(since7)
        .raw<[string | null, number, number, number]>(),

      // NOTE: GROUP BY the raw expressions, not their output aliases — grouping
      // by the alias mis-collapses rows in D1's SQLite (verified: all rows
      // landed in one bucket keyed by the first row's value). Fase 25.17: sin
      // NON_PROBE_SQL en el WHERE; `probe` sale como columna y como clave de
      // grupo, con lo que un cliente puede dar dos filas (su trafico real y el
      // que casa un patron de escaner por User-Agent).
      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, COALESCE(${IS_PROBE_SQL}, 0) AS probe,
                  count(*) AS c30, SUM(ts >= ?) AS c7, SUM(ts >= ?) AS c1
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalOnlyFilter}
           GROUP BY COALESCE(client_name, 'unknown'), COALESCE(${IS_PROBE_SQL}, 0)`
        )
        .bind(since7, since1, since30)
        .all<{ client: string; probe: number; c30: number; c7: number; c1: number }>(),

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

      // Fase 25.17 — salud. Ultimo evento de cualquier tipo (idx_ae_ts: una fila).
      db.prepare(`SELECT MAX(ts) AS ts FROM analytics_events`).first<{ ts: number | null }>(),
      // Misma consulta y misma ventana (6 h) que el cron de salud.
      loadHealthWindow(db, now),
      readCronStatuses(kv),
    ]);

  const series = rollupSeries(seriesRows, since7, seriesDailyRows);
  const agents = rollupAgents(agentRows, { d14: now - 2 * MS_7D, d7: since7, h24: since1 });
  const connectStats = rollupConnects(connectRows, since7);
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
  // topTools y el denominador del error_pct eran la MISMA consulta, ejecutada dos veces (14 k filas cada vez).
  const totalRows = toolRows;
  const errRows = errorRows.results ?? [];
  const latRows = latencyRows.results ?? [];
  const funnelByWindow: Record<WindowKey, { hit_payers: number; converted_payers: number }> = {
    d30: paywallFunnels[0],
    d7: paywallFunnels[1],
    h24: paywallFunnels[2],
  };
  const sumCol = { d30: { c: s.c30, r: s.r30, p: s.p30 }, d7: { c: s.c7, r: s.r7, p: s.p7 }, h24: { c: s.c1, r: s.r1, p: s.p1 } };
  const anonCol = { d30: agents.anon.c30, d7: agents.anon.c7, h24: agents.anon.c1 };
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
      calls_by_client: clientCallsList(clientRows, col),
      paywall_funnel: funnelByWindow[w],
      error_rate_by_tool: rollupErrorRates(errRows, totals, since),
      cogs: cogsList(toolRows, col.slice(1) as "30" | "7" | "1"),
    };
  }
  const d30 = byWindow.d30;

  // Fase 25.19 — mismo canario que el cron, solo si alguna tool rota lo pide.
  const brokenTools = findBrokenTools(healthWindow);
  const canary = await canaryFor(brokenTools, canaryFetch);

  return {
    summary: {
      calls_30d: d30.calls,
      revenue_30d: d30.revenue,
      unique_payers_30d: d30.unique_payers,
      unique_anon_agents_30d: d30.unique_anon_agents,
      returning_agents_7d: agents.returning,
      avg_latency_ms: d30.avg_latency_ms,
      p50_latency_ms: d30.p50_latency_ms,
      p95_latency_ms: d30.p95_latency_ms,
    },
    ...series,
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
    directory_coverage: connectStats.directory_coverage,
    directory_stats: directoryStatsLatest.results ?? [],
    smithery_use_count_series: (smitheryUseCountSeries.results ?? []).map((r) => ({
      day: dayLabel(r.ts),
      use_count: r.use_count,
    })),
    paywall_funnel: d30.paywall_funnel,
    surface: {
      connects_by_client: connectStats.connects_by_client,
      calls_by_client: d30.calls_by_client,
      revenue_by_client: revenueByClient.results ?? [],
      funnel_by_client: Array.from(funnelByClient.entries()).map(([client, f]) => ({ client, ...f })),
    },
    by_window: byWindow,
    retention: {
      events_days: ANALYTICS_RETENTION_DAYS,
      connect_days: CONNECT_RETENTION_DAYS,
      oldest_event_ts: oldestEvent?.ts ?? null,
      surface_days: SURFACE_WINDOW_DAYS,
    },
    health: {
      broken_tools: brokenTools.map((b) => ({ ...b, paged: brokenToolPages(b, canary) })),
      canary,
      last_event_ts: lastEvent?.ts ?? null,
      crons: cronStatuses,
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
