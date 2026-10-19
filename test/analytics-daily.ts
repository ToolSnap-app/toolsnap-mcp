/**
 * Fase B2 — resumen diario analytics_daily.
 *
 *  - rollupAnalyticsDaily: INSERT OR REPLACE de los 2 ultimos dias UTC (hoy y
 *    ayer), idempotente, con las definiciones de rollupSeries (depositos
 *    cuentan como call pero no suman revenue; connects fuera; probe por IS_PROBE_SQL).
 *  - Lectura: calls_by_day / revenue_by_day de getDashboardData salen del
 *    resumen (+ crudo de los ultimos dias) y coinciden con rollupSeries sobre
 *    los eventos crudos; el toggle internal/probe se respeta.
 *  - El cron: la tarea esta en CRON_TASK_NAMES y un fallo se propaga (runTask lo registra).
 *
 * SQL real en SQLite (node:sqlite) tras un shim minimo de D1.
 *
 * Run: npx tsx test/analytics-daily.ts
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { rollupAnalyticsDaily, dailyRollupSql, dailyRollupSince } from "../src/analytics/daily.js";
import { getDashboardData, rollupSeries } from "../src/analytics/queries.js";
import { CRON_TASK_NAMES, recordCronError, recordCronOk, readCronStatuses } from "../src/alerts/cron-status.js";

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

const DAY = 86_400_000;
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE analytics_events (
  ts INTEGER NOT NULL, payment_type TEXT NOT NULL, revenue_usdc REAL NOT NULL DEFAULT 0,
  internal INTEGER NOT NULL DEFAULT 0, client_name TEXT, client TEXT, payer TEXT DEFAULT 'anon', session_id TEXT, tool_name TEXT)`);
sqlite.exec(readFileSync(new URL("../migrations/0019_analytics_daily.sql", import.meta.url), "utf8"));

/** El panel lanza ~20 consultas; solo las de las series (y el propio rollup) corren en SQLite, el resto devuelve vacio. */
const REAL = /analytics_daily|AS dep\b|INSERT OR REPLACE/;
const log: string[] = [];
function shim(): D1Database {
  return {
    prepare(sql: string) {
      log.push(sql);
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(args as never[]));
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async raw() {
          if (!REAL.test(sql)) return [];
          return sqlite.prepare(sql).all(...(args as never[])).map((r) => Object.values(r));
        },
        async all() {
          if (!REAL.test(sql)) return { results: [], success: true, meta: {} };
          return { results: sqlite.prepare(sql).all(...(args as never[])), success: true, meta: {} };
        },
        async first() {
          if (!REAL.test(sql)) return null;
          return sqlite.prepare(sql).all(...(args as never[]))[0] ?? null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}
const db = shim();

// "Ahora": a media tarde UTC, para que hoy tenga eventos antes y despues del corte de ayer.
const now = Math.floor(Date.now() / DAY) * DAY + 15 * 3600_000;
const ins = sqlite.prepare("INSERT INTO analytics_events (ts, payment_type, revenue_usdc, internal, client_name, client) VALUES (?, ?, ?, ?, ?, ?)");
type Ev = [number, string, number, number, string | null, string | null];
const events: Ev[] = [
  [now - 40 * DAY, "paid", 0.01, 0, "claude-code", null],
  [now - 40 * DAY + 5000, "402_rejected", 0, 0, "claude-code", null],
  [now - 40 * DAY + 6000, "deposit_success", 5, 0, "claude-code", null], // call, no revenue
  [now - 40 * DAY + 7000, "connect", 0, 0, "claude-code", null], // fuera
  [now - 20 * DAY, "paid", 0.02, 1, "x-audit", null], // internal + probe
  [now - 20 * DAY + 1000, "paid", 0.03, 0, "glama", null], // probe
  [now - 9 * DAY, "paid", 0.04, 0, "cursor", null],
  [now - 6 * DAY - 1000, "paid", 0.05, 0, "cursor", null], // dentro de los 8 dias crudos, antes de since7
  [now - 5 * DAY, "free", 0, 0, "cursor", null],
  [now - 1 * DAY, "paid", 0.06, 0, "cursor", null], // ayer
  [now - 1 * DAY + 1000, "paid", 0.07, 1, "cursor", null],
  [now - 3600_000, "paid", 0.08, 0, "cursor", null], // hoy
];
for (const e of events) ins.run(...e);

console.log("rollupAnalyticsDaily");
{
  assert("SQL is INSERT OR REPLACE ... GROUP BY", /^INSERT OR REPLACE INTO analytics_daily/.test(dailyRollupSql()) && /GROUP BY day, internal/.test(dailyRollupSql()));
  assert("days=2 starts at 00:00 UTC yesterday", dailyRollupSince(now, 2) === Math.floor(now / DAY) * DAY - DAY);
  await rollupAnalyticsDaily({ PREPAID_DB: db }, now, 365);
  const full = sqlite.prepare("SELECT * FROM analytics_daily ORDER BY day, internal, probe").all() as Array<Record<string, number | string>>;
  const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const d40 = full.filter((r) => r.day === dayOf(now - 40 * DAY));
  assert("one row per (day, internal, probe); connect excluded; deposit counted as call only", d40.length === 1 && d40[0].calls === 3 && Math.abs(Number(d40[0].revenue_usdc) - 0.01) < 1e-9, JSON.stringify(d40));
  const d20 = full.filter((r) => r.day === dayOf(now - 20 * DAY));
  assert("internal and probe split into separate rows", d20.length === 2 && d20.some((r) => r.internal === 1 && r.probe === 1) && d20.some((r) => r.internal === 0 && r.probe === 1), JSON.stringify(d20));

  // Idempotente y solo 2 dias: alteramos una fila vieja y otra de ayer a mano.
  sqlite.exec(`UPDATE analytics_daily SET calls = 999`);
  const before = sqlite.prepare("SELECT count(*) AS n FROM analytics_daily").get() as { n: number };
  const wrote = await rollupAnalyticsDaily({ PREPAID_DB: db }, now);
  const rows = sqlite.prepare("SELECT day, calls FROM analytics_daily ORDER BY day").all() as Array<{ day: string; calls: number }>;
  const after = sqlite.prepare("SELECT count(*) AS n FROM analytics_daily").get() as { n: number };
  const fixed = rows.filter((r) => r.calls !== 999).map((r) => r.day);
  assert("default run recomputes only today and yesterday (older rows untouched)", fixed.every((d) => d >= dayOf(now - DAY)) && fixed.length > 0 && rows.filter((r) => r.day < dayOf(now - DAY)).every((r) => r.calls === 999), JSON.stringify(fixed));
  assert("run is idempotent (no duplicate rows) and reports rows written", before.n === after.n && wrote === fixed.length, `${wrote} vs ${fixed.length}`);
  await rollupAnalyticsDaily({ PREPAID_DB: db }, now, 365); // restaura
}

console.log("\nlectura desde el resumen");
{
  const flag = (include: boolean) => {
    const where = include ? "" : " AND internal = 0 AND NOT COALESCE((client_name='glama' OR client_name LIKE '%-audit'),0)";
    const rows = (sqlite.prepare(`SELECT ts, revenue_usdc, payment_type IN ('deposit_success','fiat_deposit_success') AS dep FROM analytics_events WHERE payment_type != 'connect'${where} ORDER BY ts`).all() as Array<Record<string, number>>).map((r) => [r.ts, r.revenue_usdc, r.dep] as [number, number, number]);
    return rollupSeries(rows, now - 7 * DAY);
  };
  const realNow = Date.now;
  Date.now = () => now;
  try {
    for (const include of [false, true]) {
      log.length = 0;
      const data = await getDashboardData(db, include, { fresh: true });
      const want = flag(include);
      const dailySql = log.find((s) => /FROM analytics_daily/.test(s)) ?? "";
      assert(`include_internal=${include}: calls_by_day == raw rollup`, JSON.stringify(data.calls_by_day) === JSON.stringify(want.calls_by_day), JSON.stringify(data.calls_by_day) + " vs " + JSON.stringify(want.calls_by_day));
      assert(`include_internal=${include}: revenue_by_day == raw rollup (days with 0 revenue allowed)`, JSON.stringify(data.revenue_by_day.filter((r) => r.revenue)) === JSON.stringify(want.revenue_by_day.filter((r) => r.revenue)), JSON.stringify(data.revenue_by_day));
      assert(`include_internal=${include}: halfhour series unchanged`, JSON.stringify(data.calls_by_halfhour) === JSON.stringify(want.calls_by_halfhour) && JSON.stringify(data.revenue_by_halfhour) === JSON.stringify(want.revenue_by_halfhour));
      assert(`include_internal=${include}: toggle decides internal/probe filter in the summary read`, include ? !/internal = 0/.test(dailySql) : /internal = 0 AND probe = 0/.test(dailySql), dailySql);
    }
  } finally {
    Date.now = realNow;
  }
}

console.log("\ncron");
{
  assert("analytics-daily is a registered cron task (health strip sees it)", (CRON_TASK_NAMES as readonly string[]).includes("analytics-daily"));
  const store = new Map<string, string>();
  const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) } as unknown as KVNamespace;
  await rollupAnalyticsDaily({ PREPAID_DB: db }, now).then(() => recordCronOk(kv, "analytics-daily"));
  const bad = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1 down"); } }) }) } as unknown as D1Database;
  let msg = "";
  await rollupAnalyticsDaily({ PREPAID_DB: bad }, now).catch((e: Error) => { msg = e.message; return recordCronError(kv, "analytics-daily", e.message); });
  const st = (await readCronStatuses(kv)).find((s) => s.name === "analytics-daily")!;
  assert("success records last_ok, a rejection propagates and is recorded as error", msg === "D1 down" && st.last_ok_ts !== null && st.last_error === "D1 down", JSON.stringify(st));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
