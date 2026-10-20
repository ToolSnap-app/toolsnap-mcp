/**
 * Fase 25.18 — fila de COGS estimado (src/analytics/cogs.ts).
 *
 * Covers:
 *  - cogsList: cogs_usdc registrado manda; si no lo hay, ejecutadas × coste
 *    unitario; las tools sin coste conocido o sin ejecutadas no salen; orden
 *    descendente; redondeo a micro-USDC.
 *  - EXECUTED_SQL es una cadena OR (no IN) con los EXECUTED_TYPES.
 *  - getDashboardData pide los cortes e30/e7/e1 y g30/g7/g1 en la MISMA
 *    consulta de top tools (ninguna consulta nueva) y rellena by_window[*].cogs.
 *
 * Pure logic — fake D1. Run: npx tsx test/analytics-cogs.ts
 */
import { cogsList, cogsTotal, EXECUTED_SQL, UNIT_COGS_USD } from "../src/analytics/cogs.js";
import { EXECUTED_TYPES } from "../src/analytics/payment-types.js";
import { getDashboardData, WINDOW_KEYS } from "../src/analytics/queries.js";

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

console.log("cogsList");
const rows = [
  { tool: "screenshot_url", e30: 30, e7: 10, e1: 0, g30: 0, g7: 0, g1: 0 },
  { tool: "image_generate", e30: 7, e7: 7, e1: 2, g30: 0.084, g7: 0.084, g1: 0.024 },
  { tool: "fetch_extract", e30: 500, e7: 120, e1: 20, g30: 0, g7: 0, g1: 0 },
  { tool: "keyword_research", e30: 0, e7: 0, e1: 0, g30: 0, g7: 0, g1: 0 },
  { tool: "remove_background", e30: null, e7: null, e1: null, g30: null, g7: null, g1: null },
];
const d30 = cogsList(rows, "30");
assert("solo tools con COGS > 0 (fetch_extract y las sin ejecutadas fuera)", d30.map((r) => r.tool).join(",") === "screenshot_url,image_generate", JSON.stringify(d30));
assert("ejecutadas × coste unitario cuando no hay cogs registrado", d30[0].calls === 30 && d30[0].cogs_usdc === 0.27);
assert("cogs registrado manda sobre la tabla de unitarios", d30[1].calls === 7 && d30[1].cogs_usdc === 0.084);
assert("orden descendente por coste", d30[0].cogs_usdc >= d30[1].cogs_usdc);
const h24 = cogsList(rows, "1");
assert("ventana 24h: screenshot sin ejecutadas desaparece", h24.length === 1 && h24[0].tool === "image_generate" && h24[0].cogs_usdc === 0.024, JSON.stringify(h24));
assert("redondeo a micro-USDC", cogsList([{ tool: "screenshot_url", e30: 3, e7: 0, e1: 0, g30: 0, g7: 0, g1: 0 }], "30")[0].cogs_usdc === 0.027);
assert("cogsTotal suma", Math.abs(cogsTotal(d30) - 0.354) < 1e-9);
assert("tabla de unitarios: las tres tools de precio fijo con proveedor", Object.keys(UNIT_COGS_USD).sort().join(",") === "keyword_research,remove_background,screenshot_url");

console.log("EXECUTED_SQL");
assert("cadena OR, no IN", EXECUTED_SQL.startsWith("(payment_type = '") && EXECUTED_SQL.includes(" OR ") && !/\bIN\b/.test(EXECUTED_SQL));
assert("cubre todos los EXECUTED_TYPES", EXECUTED_TYPES.every((t) => EXECUTED_SQL.includes(`payment_type = '${t}'`)));

console.log("getDashboardData");
interface Captured { sql: string; args: unknown[] }
const calls: Captured[] = [];
const db = {
  prepare(sql: string) {
    const entry: Captured = { sql, args: [] };
    calls.push(entry);
    const rowsFor = (): unknown[] => {
      if (sql.includes("GROUP BY tool_name") && sql.includes("AS e30")) {
        return [
          { tool: "screenshot_url", c30: 40, c7: 12, c1: 1, e30: 30, e7: 10, e1: 0, g30: 0, g7: 0, g1: 0 },
          { tool: "fetch_extract", c30: 600, c7: 150, c1: 25, e30: 580, e7: 140, e1: 22, g30: 0, g7: 0, g1: 0 },
        ];
      }
      return [];
    };
    const stmt = {
      bind(...args: unknown[]) { entry.args = args; return stmt; },
      async all() { return { results: rowsFor(), success: true, meta: {} }; },
      async raw() { return rowsFor(); },
      async first() { return rowsFor()[0] ?? null; },
    };
    return stmt;
  },
} as unknown as D1Database;
const data = await getDashboardData(db, false, { fresh: true });
const toolSql = calls.filter((c) => c.sql.includes("GROUP BY tool_name"));
assert("una sola consulta por tool, con los seis cortes nuevos", toolSql.length === 1 && ["e30", "e7", "e1", "g30", "g7", "g1"].every((c) => toolSql[0].sql.includes(`AS ${c}`)), String(toolSql.length));
assert("la consulta usa la cadena OR de EXECUTED_SQL", toolSql[0].sql.includes(EXECUTED_SQL) && !/payment_type IN/.test(toolSql[0].sql));
assert("siete binds: 3 pares (7d, 24h) + since30", toolSql[0].args.length === 7);
assert("by_window[*].cogs presente en las tres ventanas", WINDOW_KEYS.every((k) => Array.isArray(data.by_window[k].cogs)));
assert("30d: screenshot_url 30 × $0.009 = $0.27; fetch_extract fuera", data.by_window.d30.cogs.length === 1 && data.by_window.d30.cogs[0].cogs_usdc === 0.27 && data.by_window.d30.cogs[0].calls === 30, JSON.stringify(data.by_window.d30.cogs));
assert("24h: sin ejecutadas, sin fila", data.by_window.h24.cogs.length === 0);
assert("top_tools sigue igual (c30)", data.by_window.d30.top_tools[0].tool === "fetch_extract" && data.by_window.d30.top_tools[0].calls === 600);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
