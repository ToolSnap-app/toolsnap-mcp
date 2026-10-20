/**
 * Fase 25.18 — COGS estimado por tool y ventana, para la fila "COGS / margen"
 * de la tarjeta Credits del panel. Solo analitica: nunca se usa para cobrar.
 *
 * Dos fuentes, por este orden:
 *  1. `cogs_usdc` registrado en el evento (las tools de precio dinamico de
 *     fal.ai lo graban al ejecutarse: estimateCogsUsdc = payPerCall / 2).
 *  2. Si la tool no lo registra, llamadas EJECUTADAS × coste unitario
 *     conocido (UNIT_COGS_USD). Las tools sin coste externo (fetch_*, csv_query…)
 *     no estan en la tabla y por tanto no salen: la fila solo lista tools con
 *     COGS > 0 en la ventana (decision de Unai, 2026-10-20).
 *
 * Las cifras salen de las mismas filas que ya lee la consulta de "top tools"
 * (sumas condicionales sobre el mismo GROUP BY tool_name): cero lecturas
 * nuevas en D1.
 */
import { EXECUTED_TYPES } from "./payment-types.js";

/**
 * Coste unitario (USD por llamada ejecutada) de las tools de precio fijo con
 * proveedor externo. Fuentes en el propio repo:
 *  - screenshot_url: ScreenshotOne, overage ~$0.009/captura (alerts/usage-alerts.ts).
 *  - keyword_research: DataForSEO, ~$0.002-0.003 por lote (tools/keyword-research.ts);
 *    se toma el extremo alto para no infravalorar nunca el coste.
 *  - remove_background: fal.ai imageutils/rembg; no hay tarifa codificada, asi
 *    que se aplica la misma regla que el resto de tools de fal (precio / 2 =
 *    $0.03 / 2). Documentado como estimacion.
 */
export const UNIT_COGS_USD: Readonly<Record<string, number>> = {
  screenshot_url: 0.009,
  keyword_research: 0.003,
  remove_background: 0.015,
};

/**
 * Fragmento SQL `(payment_type = 'a' OR payment_type = 'b' ...)`: cadena OR y
 * no IN, por la misma razon que IS_PROBE_SQL (fase 25.17): D1 cobra cada
 * comprobacion contra una lista IN como una fila leida mas. Constante, nunca
 * entrada de usuario.
 */
export const EXECUTED_SQL = `(${EXECUTED_TYPES.map((t) => `payment_type = '${t}'`).join(" OR ")})`;

/** Una fila de la consulta de top tools, con los cortes de ejecutadas y COGS registrado. */
export interface ToolCogsRow {
  tool: string;
  /** Llamadas ejecutadas (EXECUTED_TYPES) en cada ventana. */
  e30: number | null;
  e7: number | null;
  e1: number | null;
  /** Suma de cogs_usdc registrado en eventos ejecutados, por ventana. */
  g30: number | null;
  g7: number | null;
  g1: number | null;
}

export interface CogsRow {
  tool: string;
  /** Llamadas ejecutadas en la ventana (las que costaron dinero). */
  calls: number;
  cogs_usdc: number;
}

const MICRO = 1_000_000;

/** Redondeo a micro-USDC: evita el ruido binario de sumar muchos 0.009. */
function roundUsdc(n: number): number {
  return Math.round(n * MICRO) / MICRO;
}

/**
 * Filas de COGS de una ventana, solo tools con COGS > 0, de mayor a menor coste.
 * `col` elige el corte ("30" | "7" | "1"), igual que windowedList.
 */
export function cogsList(rows: readonly ToolCogsRow[], col: "30" | "7" | "1"): CogsRow[] {
  const out: CogsRow[] = [];
  for (const r of rows) {
    const calls = Number(r[`e${col}` as const] ?? 0);
    if (calls <= 0) continue;
    const logged = Number(r[`g${col}` as const] ?? 0);
    const unit = UNIT_COGS_USD[r.tool];
    const cogs = logged > 0 ? logged : unit ? calls * unit : 0;
    if (cogs <= 0) continue;
    out.push({ tool: r.tool, calls, cogs_usdc: roundUsdc(cogs) });
  }
  return out.sort((a, b) => b.cogs_usdc - a.cogs_usdc);
}

/** Suma de una lista de COGS, en USDC redondeado a micro. */
export function cogsTotal(rows: readonly CogsRow[]): number {
  return roundUsdc(rows.reduce((s, r) => s + r.cogs_usdc, 0));
}
