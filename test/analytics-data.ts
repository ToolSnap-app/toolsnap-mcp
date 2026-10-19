/**
 * Fase 25.17 — Analytics v2 (B): datos y coste del panel.
 *
 * Covers:
 *  - Split real vs scanner: connects_by_client y calls_by_client devuelven
 *    `probe` por fila (sin NON_PROBE_SQL en el WHERE); directory_coverage se
 *    deriva solo de los connects probe (ya no hay consulta aparte).
 *  - Salud: broken_tools sale de loadHealthWindow + findBrokenTools (lo mismo
 *    que el cron); last_event_ts; crons desde KV; el KV roto no tumba nada.
 *  - Estado de los crons: recordCronOk/recordCronError con su presupuesto de puts.
 *  - ?fresh: dos llamadas con fresh = dos conjuntos de consultas; sin fresh, la
 *    cache de 5 min sirve la segunda.
 *  - rollupSeries / rollupAgents dan lo que daban las consultas SQL que sustituyen.
 *  - IS_PROBE_SQL (cadena OR, no IN) clasifica igual que el IN original.
 *
 * Pure logic — fake D1 (captura SQL y binds), fake KV.
 *
 * Run: npx tsx test/analytics-data.ts
 */
import {
  getDashboardData,
  rollupSeries,
  rollupConnects,
  rollupAgents,
  canonicalAgents,
  IS_PROBE_SQL,
  NON_PROBE_SQL,
  SURFACE_WINDOW_DAYS,
} from "../src/analytics/queries.js";
import { findBrokenTools, loadHealthWindow, type WindowRow } from "../src/alerts/health.js";
import { CRON_TASK_NAMES, recordCronOk, recordCronError, readCronStatuses } from "../src/alerts/cron-status.js";
import { PROBE_CLIENTS } from "../src/analytics/surface.js";

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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
interface Captured {
  sql: string;
  args: unknown[];
}
/** `rowsFor` decide por SQL: objetos para .all()/.first(), arrays para .raw(). */
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
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function fakeKv(initial: Record<string, string> = {}): KVNamespace & { store: Map<string, string>; puts: number; deletes: number } {
  const store = new Map(Object.entries(initial));
  const kv = {
    store,
    puts: 0,
    deletes: 0,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      kv.puts += 1;
      store.set(k, v);
    },
    delete: async (k: string) => {
      kv.deletes += 1;
      store.delete(k);
    },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string>; puts: number; deletes: number };
}

const brokenKv = {
  get: async () => {
    throw new Error("KV daily limit exceeded");
  },
  put: async () => {
    throw new Error("KV daily limit exceeded");
  },
  delete: async () => {
    throw new Error("KV daily limit exceeded");
  },
} as unknown as KVNamespace;

const DAY = 86_400_000;
const isConnectQuery = (sql: string) => /payment_type = 'connect'/.test(sql) && /client_name, COALESCE/.test(sql);
const isCallsByClientQuery = (sql: string) => /AS probe/.test(sql) && /GROUP BY COALESCE\(client_name/.test(sql);
const isHealthWindowQuery = (sql: string) => /LIMIT 5000\b/.test(sql);

// ---------------------------------------------------------------------------
// 1. Split real vs scanner
// ---------------------------------------------------------------------------
console.log("split real vs scanner");
{
  const now = Date.now();
  const connectRows: Array<[string | null, number, number, number]> = [
    ["claude-code", 0, 0, now - 1000],
    ["claude-code", 0, 0, now - 2000],
    ["glama", 1, 0, now - 3000],
    ["glama", 1, 0, now - 9000],
    ["fixter-monitoring", 1, 0, now - 5000],
    ["our-audit", 1, 1, now - 100], // internal probe: no es cobertura de directorios
    [null, 0, 0, now - 4000],
  ];
  const { db, calls } = fakeD1((sql) => {
    if (isConnectQuery(sql)) return connectRows;
    if (isCallsByClientQuery(sql))
      return [
        { client: "claude-code", probe: 0, c30: 5, c7: 3, c1: 1 },
        { client: "glama", probe: 1, c30: 9, c7: 9, c1: 0 },
        { client: "claude-code", probe: 1, c30: 2, c7: 0, c1: 0 }, // mismo cliente, UA de crawler
      ];
    return [];
  });
  const data = await getDashboardData(db, true, { fresh: true });

  const connectSql = calls.find((c) => isConnectQuery(c.sql))!;
  const callsSql = calls.find((c) => isCallsByClientQuery(c.sql))!;
  assert("connects query has IS_PROBE_SQL as a column", connectSql.sql.includes(IS_PROBE_SQL));
  assert("connects query does NOT filter probes in the WHERE", !connectSql.sql.includes(NON_PROBE_SQL.trim()) && !/NOT COALESCE/.test(connectSql.sql));
  assert("calls_by_client query does not filter probes either", !/NOT COALESCE/.test(callsSql.sql) && callsSql.sql.includes(IS_PROBE_SQL));
  const internalOff = fakeD1();
  await getDashboardData(internalOff.db, false, { fresh: true });
  const off = internalOff.calls.find((c) => isConnectQuery(c.sql))!;
  assert("internal = 0 still follows the toggle (off: present; on: absent)", /AND internal = 0/.test(off.sql) && !/AND internal = 0/.test(connectSql.sql));
  assert("connects window is SURFACE_WINDOW_DAYS (7)", SURFACE_WINDOW_DAYS === 7 && Math.abs(now - (connectSql.args[0] as number) - 7 * DAY) < 60_000, String(connectSql.args[0]));
  assert("no separate directory_coverage query any more", !calls.some((c) => /AS hits/.test(c.sql)));

  const conn = data.surface.connects_by_client;
  assert("connects_by_client: one row per (client, probe) with the flag", conn.some((r) => r.client === "claude-code" && !r.probe && r.connects === 2) && conn.some((r) => r.client === "glama" && r.probe && r.connects === 2), JSON.stringify(conn));
  assert("connects_by_client: sorted by connects desc, NULL name -> unknown", conn[0].connects >= conn[conn.length - 1].connects && conn.some((r) => r.client === "unknown" && !r.probe));
  const cov = data.directory_coverage;
  assert("directory_coverage derives only from probe, non-internal connects", cov.length === 2 && cov.every((r) => r.client === "glama" || r.client === "fixter-monitoring") && !cov.some((r) => r.client === "our-audit"), JSON.stringify(cov));
  const glama = cov.find((r) => r.client === "glama")!;
  assert("directory_coverage: hits count and last_seen is the newest", glama.hits === 2 && glama.last_seen === now - 3000, JSON.stringify(glama));
  assert("directory_coverage sorted by last_seen desc", cov[0].last_seen >= cov[1].last_seen);

  const d30 = data.by_window.d30.calls_by_client;
  assert("calls_by_client carries probe flags (d30)", d30.length === 3 && d30.find((r) => r.client === "claude-code" && !r.probe)?.calls === 5 && d30.find((r) => r.client === "claude-code" && r.probe)?.calls === 2 && d30.find((r) => r.client === "glama")?.probe === true, JSON.stringify(d30));
  const h24 = data.by_window.h24.calls_by_client;
  assert("calls_by_client windows cut by their own column (h24: only the 1 real call)", h24.length === 1 && h24[0].calls === 1 && h24[0].probe === false, JSON.stringify(h24));
  assert("surface.calls_by_client is the 30d cut", data.surface.calls_by_client.length === 3);
  assert("summary KPIs still exclude probes (internalFilter keeps NON_PROBE_SQL)", calls.filter((c) => /count\(\*\) AS c30, SUM\(ts >= \?\) AS c7, SUM\(ts >= \?\) AS c1,/.test(c.sql)).length === 1);
  const withFilter = fakeD1();
  await getDashboardData(withFilter.db, false, { fresh: true });
  const summarySql = withFilter.calls.find((c) => /unique|p30/.test(c.sql) || /AS p30/.test(c.sql))!;
  assert("...and with the toggle off the summary filters probes in SQL", summarySql.sql.includes(NON_PROBE_SQL.trim()));
}

// rollupConnects en frio: nada que agrupar
{
  const out = rollupConnects([], 0);
  assert("rollupConnects of nothing is empty", out.connects_by_client.length === 0 && out.directory_coverage.length === 0);
}

// ---------------------------------------------------------------------------
// 2. Salud
// ---------------------------------------------------------------------------
console.log("\nhealth");
{
  const now = Date.now();
  // fetch_extract: 6 errores internos de tres clientes distintos -> rota. screenshot_url: sana.
  const win: WindowRow[] = [];
  const clients: Array<[string, string]> = [
    ["claude-code", "claude-cli/1.0"],
    ["cursor", "cursor/0.4"],
    ["python-script", "python-httpx/0.27"],
  ];
  for (let i = 0; i < 6; i++) {
    const [client_name, client] = clients[i % 3];
    win.push({ tool_name: "fetch_extract", payment_type: "tool_error", detail: "boom: unexpected state", client_name, client, payer: `anon:${i}` });
  }
  for (let i = 0; i < 6; i++) {
    win.push({ tool_name: "screenshot_url", payment_type: "free_tool", detail: null, client_name: "claude-code", client: "claude-cli/1.0", payer: `anon:${i}` });
  }
  // un escaner rompiendo todo no cuenta
  for (let i = 0; i < 8; i++) {
    win.push({ tool_name: "csv_query", payment_type: "tool_error", detail: "x", client_name: "glama", client: "glama/1", payer: `anon:s${i}` });
  }
  const kv = fakeKv({
    "cron:last_ok:health": String(now - 10 * 60_000),
    "cron:last_error:usage-alerts": JSON.stringify({ ts: now - 60_000, message: "D1 down", muted: false }),
    "cron:last_error:x-agent-metrics": JSON.stringify({ ts: now - 120_000, message: "(402) credits-depleted", muted: true }),
  });
  const { db, calls } = fakeD1((sql) => {
    if (isHealthWindowQuery(sql)) return win;
    if (/MAX\(ts\)/.test(sql)) return [{ ts: now - 5 * 60_000 }];
    return [];
  });
  const data = await getDashboardData(db, false, { kv, fresh: true });
  const expected = findBrokenTools(win);
  assert("sanity: findBrokenTools lists only fetch_extract", expected.length === 1 && expected[0].tool === "fetch_extract", JSON.stringify(expected));
  assert("health.broken_tools == findBrokenTools over the same window rows", JSON.stringify(data.health.broken_tools) === JSON.stringify(expected), JSON.stringify(data.health.broken_tools));
  assert("health.last_event_ts is MAX(ts)", data.health.last_event_ts === now - 5 * 60_000);
  const crons = data.health.crons;
  assert("crons lists the six scheduled tasks in order", crons.map((c) => c.name).join() === CRON_TASK_NAMES.join() && crons.length === 6);
  assert("crons: last_ok read from KV", crons.find((c) => c.name === "health")?.last_ok_ts === now - 10 * 60_000);
  assert("crons: last_error read from KV", crons.find((c) => c.name === "usage-alerts")?.last_error === "D1 down");
  assert("crons: muted flag for the known X-credits failure", crons.find((c) => c.name === "x-agent-metrics")?.muted === true && crons.find((c) => c.name === "usage-alerts")?.muted === false);
  assert("crons: never-run tasks are null/null", crons.find((c) => c.name === "directory-stats")?.last_ok_ts === null && crons.find((c) => c.name === "directory-stats")?.last_error === null);

  const hw = calls.find((c) => isHealthWindowQuery(c.sql))!;
  assert("health window: same query and 6 h window as the cron", /payment_type <> 'connect' AND internal = 0/.test(hw.sql) && Math.abs(now - (hw.args[0] as number) - 6 * 3_600_000) < 60_000);
  const direct = fakeD1(() => win);
  const rows = await loadHealthWindow(direct.db, now);
  assert("loadHealthWindow returns the rows as-is", rows.length === win.length && direct.calls[0].sql === hw.sql);

  // KV roto: el panel sigue cargando
  const warnKeep = console.warn;
  console.warn = () => {};
  const broken = await getDashboardData(fakeD1().db, false, { kv: brokenKv, fresh: true });
  console.warn = warnKeep;
  assert("a dead KV leaves crons null and does not break the payload", broken.health.crons.length === 6 && broken.health.crons.every((c) => c.last_ok_ts === null && c.last_error === null));
  const noKv = await getDashboardData(fakeD1().db, false, { fresh: true });
  assert("no KV binding: same", noKv.health.crons.length === 6 && noKv.health.last_event_ts === null && noKv.health.broken_tools.length === 0);
}

// ---------------------------------------------------------------------------
// 3. Estado de los crons: presupuesto de puts
// ---------------------------------------------------------------------------
console.log("\ncron status (KV budget)");
{
  const kv = fakeKv();
  const t0 = 1_800_000_000_000;
  await recordCronOk(kv, "health", t0);
  assert("first success writes last_ok", kv.puts === 1 && kv.store.get("cron:last_ok:health") === String(t0));
  for (let i = 1; i <= 11; i++) await recordCronOk(kv, "health", t0 + i * 5 * 60_000);
  assert("a 5-min cron writes at most once per hour (12 runs, 1 put)", kv.puts === 1, `${kv.puts} puts`);
  await recordCronOk(kv, "health", t0 + 61 * 60_000);
  assert("...and refreshes after the hour", kv.puts === 2);

  await recordCronError(kv, "health", "D1 down", false, t0 + 70 * 60_000);
  const putsAfterFirstError = kv.puts;
  await recordCronError(kv, "health", "D1 down", false, t0 + 75 * 60_000);
  assert("the same error within 30 min is not rewritten", kv.puts === putsAfterFirstError);
  await recordCronError(kv, "health", "D1 down", false, t0 + 110 * 60_000);
  assert("...but is after 30 min", kv.puts === putsAfterFirstError + 1);
  await recordCronError(kv, "health", "different failure", false, t0 + 111 * 60_000);
  assert("a different message is written right away", kv.puts === putsAfterFirstError + 2);

  const statusBad = (await readCronStatuses(kv)).find((c) => c.name === "health")!;
  assert("status shows the error newer than the last OK", statusBad.last_error === "different failure" && statusBad.last_error_ts! > statusBad.last_ok_ts!);
  await recordCronOk(kv, "health", t0 + 115 * 60_000);
  const statusGood = (await readCronStatuses(kv)).find((c) => c.name === "health")!;
  assert("a success clears the error and stamps last_ok", statusGood.last_error === null && statusGood.last_ok_ts === t0 + 115 * 60_000 && kv.deletes === 1);

  await recordCronError(kv, "x-agent-metrics", "x".repeat(1000));
  assert("long messages are truncated", ((await readCronStatuses(kv)).find((c) => c.name === "x-agent-metrics")!.last_error ?? "").length === 300);

  const warn = console.warn;
  console.warn = () => {};
  let threw = false;
  try {
    await recordCronOk(brokenKv, "health");
    await recordCronError(brokenKv, "health", "x");
    await readCronStatuses(brokenKv);
  } catch {
    threw = true;
  }
  console.warn = warn;
  assert("a dead KV never throws (best-effort)", !threw);
  await recordCronOk(undefined, "health");
  assert("an absent KV is a no-op", true);
}

// ---------------------------------------------------------------------------
// 4. ?fresh salta la cache de 5 min
// ---------------------------------------------------------------------------
console.log("\nfresh vs cache");
{
  const { db, calls } = fakeD1();
  await getDashboardData(db, false, { fresh: true });
  const perLoad = calls.length;
  assert("a load runs a bounded set of queries (<= 22 D1 statements)", perLoad > 15 && perLoad <= 22, String(perLoad));
  await getDashboardData(db, false, { fresh: true });
  assert("two consecutive fresh calls run two sets of queries", calls.length === perLoad * 2, `${calls.length} vs ${perLoad * 2}`);
  await getDashboardData(db, false);
  assert("without fresh the next call is served by the 5-min cache", calls.length === perLoad * 2);
  await getDashboardData(db, true, { fresh: true });
  await getDashboardData(db, true);
  assert("the cache is per toggle: internal=1 has its own entry", calls.length === perLoad * 3);
}

// ---------------------------------------------------------------------------
// 5. rollupSeries y rollupAgents == las consultas SQL que sustituyen
// ---------------------------------------------------------------------------
console.log("\nrollupSeries / rollupAgents");
{
  const d = (n: number) => n * DAY;
  const base = Math.floor(1_790_000_000_000 / DAY) * DAY; // medianoche UTC
  const since7 = base + d(10);
  const rows: Array<[number, number, number]> = [
    [base + 1000, 0.005, 0],
    [base + 2000, 0.1, 0],
    [base + 3000, 5, 1], // deposito: cuenta como llamada, no como revenue
    [base + d(1) + 10, 0, 1], // dia solo de depositos: aparece en calls, no en revenue
    [base + d(10) + 900_000, 0.2, 0],
    [base + d(10) + 1_900_000, 0.1, 0],
    [base + d(10) + 1_901_000, 0.2, 0],
  ];
  const out = rollupSeries(rows, since7);
  assert("calls_by_day counts every row (deposits included), by UTC day, ascending", JSON.stringify(out.calls_by_day.map((r) => r.calls)) === "[3,1,3]" && out.calls_by_day[0].day < out.calls_by_day[1].day, JSON.stringify(out.calls_by_day));
  assert("revenue_by_day excludes deposits and days with only deposits", out.revenue_by_day.length === 2 && out.revenue_by_day[0].revenue === 0.105, JSON.stringify(out.revenue_by_day));
  assert("revenue is rounded to micro-USDC (0.1 + 0.2 + 0.1 -> 0.5, no float noise)", out.revenue_by_day[1].revenue === 0.5, String(out.revenue_by_day[1].revenue));
  assert("halfhour series only cover the last 7 days", out.calls_by_halfhour.every((r) => r.ts >= Math.floor(since7 / 1800000) * 1800000) && out.calls_by_halfhour.reduce((s, r) => s + r.calls, 0) === 3);
  assert("halfhour buckets are 30 min aligned and ascending", out.calls_by_halfhour.length === 2 && out.calls_by_halfhour[0].ts % 1800000 === 0 && out.calls_by_halfhour[0].ts < out.calls_by_halfhour[1].ts && out.calls_by_halfhour[1].calls === 2);
  assert("revenue_by_halfhour sums per bucket", out.revenue_by_halfhour.length === 2 && out.revenue_by_halfhour[1].revenue === 0.3, JSON.stringify(out.revenue_by_halfhour));
  const empty = rollupSeries([], since7);
  assert("empty input -> empty series", empty.calls_by_day.length === 0 && empty.revenue_by_halfhour.length === 0);
}
{
  // Dos payers anonimos en la misma sesion = un agente; un payer en dos sesiones = un agente.
  const now = 1_800_000_000_000;
  const rows: Array<[string, string | null, number]> = [
    ["anon:b", "s1", now - 1000],
    ["anon:a", "s1", now - 2000], // misma sesion que anon:b -> ancla anon:a
    ["anon:c", "s2", now - 3000],
    ["anon:c", "s3", now - 4000], // un payer, dos sesiones: sigue siendo uno
    ["anon:d", null, now - 5000], // sin sesion: el mismo
    ["0xwallet", "s4", now - 6000],
    ["anon:old", null, now - 20 * DAY], // fuera de la ventana de 14 d pero dentro de 30
  ];
  const canon = canonicalAgents(rows);
  assert("canonicalAgents collapses payers that share a session to the smallest anchor", canon.get("anon:b") === "anon:a" && canon.get("anon:a") === "anon:a");
  assert("...and leaves sessionless payers as themselves", canon.get("anon:d") === "anon:d" && canon.get("0xwallet") === "0xwallet");
  const out = rollupAgents(rows, { d14: now - 14 * DAY, d7: now - 7 * DAY, h24: now - DAY });
  assert("unique anon agents 30d = a(b), c, d, old = 4", out.anon.c30 === 4, JSON.stringify(out.anon));
  assert("...7d excludes the old one; 24h = same recent ones", out.anon.c7 === 3 && out.anon.c1 === 3, JSON.stringify(out.anon));
  assert("wallets are not anonymous agents", !JSON.stringify(out.anon).includes("wallet"));
  // returning: el mismo agente esta esta semana y la anterior
  const week: Array<[string, string | null, number]> = [
    ["anon:x", "sx", now - 1 * DAY],
    ["anon:y", "sx", now - 9 * DAY], // misma sesion que x -> misma identidad canonica
    ["anon:z", null, now - 2 * DAY], // solo esta semana
    ["anon:q", null, now - 10 * DAY], // solo la anterior
  ];
  assert("returning agents = identities seen in both weeks (x/y collapse to one)", rollupAgents(week, { d14: now - 14 * DAY, d7: now - 7 * DAY, h24: now - DAY }).returning === 1);
}

// ---------------------------------------------------------------------------
// 6. IS_PROBE_SQL: la cadena OR clasifica igual que el IN original
// ---------------------------------------------------------------------------
console.log("\nIS_PROBE_SQL");
{
  assert("no IN-list on client_name (D1 bills each IN check as a row read)", !/client_name IN/i.test(IS_PROBE_SQL));
  assert("every PROBE_CLIENTS name appears as an equality", Array.from(PROBE_CLIENTS).every((c) => IS_PROBE_SQL.includes(`client_name = '${c.replace(/'/g, "''")}'`)));
  let sqlite: typeof import("node:sqlite") | null = null;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    console.log("  (node:sqlite not available: classification run skipped)");
  }
  if (sqlite) {
    const dbm = new sqlite.DatabaseSync(":memory:");
    dbm.exec("CREATE TABLE t (id INTEGER, client_name TEXT, client TEXT)");
    const cases: Array<[string | null, string | null, boolean]> = [
      ["glama", null, true],
      ["Glama", null, false], // IN era sensible a mayusculas (BINARY)
      ["fixter-monitoring", "Java-http-client/25", true],
      ["some-probe", null, true], // patron %probe%
      ["x-audit", null, true], // patron %-audit
      ["claude-code", "MiBot/0.1 (+https://mibot.example/bot)", true], // patron de UA
      ["claude-code", "claude-cli/1.0", false],
      [null, null, false], // NULL no es probe (COALESCE a 0)
      ["cursor", null, false],
    ];
    const ins = dbm.prepare("INSERT INTO t VALUES (?, ?, ?)");
    cases.forEach(([n, c], i) => ins.run(i, n, c));
    const rows = dbm.prepare(`SELECT id, COALESCE(${IS_PROBE_SQL}, 0) AS probe FROM t ORDER BY id`).all() as Array<{ id: number; probe: number }>;
    const wrong = rows.filter((r) => !!r.probe !== cases[r.id][2]).map((r) => `${cases[r.id][0]}/${cases[r.id][1]} -> ${r.probe}`);
    assert("classifies exact names, name patterns, UA pattern, NULLs and case like the IN version did", wrong.length === 0, wrong.join("; "));
    const kept = dbm.prepare(`SELECT count(*) AS n FROM t WHERE 1 = 1${NON_PROBE_SQL}`).get() as { n: number };
    assert("NON_PROBE_SQL keeps exactly the non-probe rows (NULL names stay)", kept.n === cases.filter((c) => !c[2]).length, String(kept.n));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
