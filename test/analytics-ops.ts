/**
 * Fase 25.16 — ops del panel de analytics.
 *  - /analytics/data exige cf-access-authenticated-user-email.
 *  - /reports/analytics: Bearer principal, ?token= deprecado (console.warn).
 *  - runRetention: 3 tramos con log de filas; si falla avisa por Telegram
 *    una vez (throttle KV) y no relanza.
 *
 * Run: npx tsx test/analytics-ops.ts
 */
import worker from "../src/index.js";
import { runRetention } from "../src/alerts/usage-alerts.js";
import type { Env } from "../src/index.js";

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

const TOKEN = "t".repeat(40);

function fakeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

/** D1 fake: every statement resolves with empty results / changes=7, or rejects. */
function fakeD1(mode: "ok" | "fail", sqls: string[] = []) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        run: async () => {
          sqls.push(sql);
          if (mode === "fail") throw new Error("D1 down");
          return { success: true, meta: { changes: 7 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    batch: async () => [],
  };
}

function makeEnv(d1: unknown, kv: KVNamespace = fakeKv()): Env {
  return {
    X402_NONCES: kv,
    PREPAID_DB: d1,
    ABUSE_RL: { limit: async () => ({ success: true }) },
    FREE_FETCH_RL: { limit: async () => ({ success: true }) },
    ANALYTICS_READ_TOKEN: TOKEN,
    TELEGRAM_BOT_TOKEN: "bot",
    TELEGRAM_CHAT_ID: "chat",
  } as unknown as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (env: Env, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://mcp.toolsnap.app${path}`, { headers }), env, ctx);

// Capture console.warn/log and Telegram fetches.
const warns: string[] = [];
const logs: string[] = [];
const origWarn = console.warn;
const origLog = console.log;
const origError = console.error;
const telegram: string[] = [];
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.telegram.org")) {
    telegram.push(JSON.parse(String(init?.body)).text);
    return new Response("{}", { status: 200 });
  }
  return origFetch(input, init);
}) as typeof fetch;

console.log("=== Fase 25.16 analytics ops tests ===\n");

console.log("/analytics/data");
{
  const env = makeEnv(fakeD1("ok"));
  const r1 = await call(env, "/analytics/data");
  assert("without Access header → 401", r1.status === 401, String(r1.status));
  const r2 = await call(env, "/analytics/data", { "cf-access-authenticated-user-email": "a@b.c" });
  assert("with Access header → not 401", r2.status !== 401, String(r2.status));
}

console.log("/reports/analytics");
{
  const env = makeEnv(fakeD1("ok"));
  const bearer = await call(env, "/reports/analytics", { Authorization: `Bearer ${TOKEN}` });
  assert("valid Bearer → 200", bearer.status === 200, String(bearer.status));
  const bad = await call(env, "/reports/analytics", { Authorization: "Bearer wrong" });
  assert("invalid Bearer → 401", bad.status === 401, String(bad.status));
  const none = await call(env, "/reports/analytics");
  assert("no credentials → 401", none.status === 401, String(none.status));
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  const q = await call(env, `/reports/analytics?token=${TOKEN}`);
  const qWarned = warns.some((w) => w.includes("deprecated"));
  const q2 = await call(env, "/reports/analytics", { Authorization: `Bearer ${TOKEN}` });
  const bearerQuiet = warns.length === 1;
  console.warn = origWarn;
  assert("?token= valid → 200", q.status === 200, String(q.status));
  assert("?token= emits deprecation console.warn", qWarned);
  assert("Bearer does not warn", q2.status === 200 && bearerQuiet);
}

console.log("runRetention");
console.log = (...a: unknown[]) => void logs.push(a.join(" "));
console.error = () => {};
console.warn = () => {};
{
  const sqls: string[] = [];
  await runRetention(makeEnv(fakeD1("ok", sqls)));
  console.log = origLog;
  assert("3 tramos executed", sqls.length === 3 && sqls.some((s) => s.includes("directory_stats")), String(sqls.length));
  assert("rows deleted logged per tramo", logs.filter((l) => l.includes("deleted 7 rows")).length === 3, logs.join("|"));
  assert("no Telegram when all succeed", telegram.length === 0);

  const kv = fakeKv();
  const env = makeEnv(fakeD1("fail"), kv);
  let threw = false;
  try {
    await runRetention(env);
    await runRetention(env);
  } catch {
    threw = true;
  }
  console.warn = origWarn;
  console.error = origError;
  assert("failure does not rethrow", !threw);
  assert("Telegram sent exactly once (24 h throttle)", telegram.length === 1, String(telegram.length));
  assert("message text", telegram[0]?.includes("🔴 *retención de analytics fallando*") && telegram[0].includes("D1 down"), telegram[0]);
  assert("throttle key set", kv.store.has("alert:retention"));
}

globalThis.fetch = origFetch;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
