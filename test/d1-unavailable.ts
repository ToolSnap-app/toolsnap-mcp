/**
 * Fase E — D1 unavailable (quota 7500) must degrade cleanly.
 *
 * Fake D1 throws the real error D1 returned on 2026-10-19 on every query.
 *  - initialize / tools/list / a free tool still answer 200 with a result.
 *  - a call with an OAuth token answers a readable JSON-RPC -32000.
 *  - GET /analytics/data (Access header) answers 503 JSON + Retry-After.
 *  - checkServerHealth pages once (throttled) and does not throw.
 *
 * Run: npx tsx test/d1-unavailable.ts
 */
import "./_support/text-modules.js";
import { checkServerHealth } from "../src/alerts/health.js";
import { isD1Unavailable } from "../src/d1-errors.js";
import type { Env } from "../src/index.js";

const { default: worker } = await import("../src/index.js");

let failed = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

const D1_MSG = "D1_ERROR: D1 DB reached its daily read limit: SQLITE_ERROR (code 7500)";
const boom = async () => {
  throw new Error(D1_MSG);
};
const brokenD1 = {
  prepare: () => {
    const stmt: Record<string, unknown> = { run: boom, first: boom, all: boom, raw: boom };
    stmt.bind = () => stmt;
    return stmt;
  },
  batch: boom,
  exec: boom,
};

const kvStore = new Map<string, string>();
const kv = {
  get: async (k: string) => kvStore.get(k) ?? null,
  put: async (k: string, v: string) => void kvStore.set(k, v),
  delete: async (k: string) => void kvStore.delete(k),
  list: async () => ({ keys: [], list_complete: true, cursor: "" }),
} as unknown as KVNamespace;

const env = {
  X402_NONCES: kv,
  PREPAID_DB: brokenD1,
  ABUSE_RL: { limit: async () => ({ success: true }) },
  FREE_FETCH_RL: { limit: async () => ({ success: true }) },
  X402_NETWORK: "eip155:8453",
  X402_PRICE_USDC: "0.02",
  X402_PREPAID_PRICE_USDC: "0.01",
  X402_MIN_DEPOSIT_USDC: "0.50",
  BASE_RPC_URL: "https://mainnet.base.org",
  X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000dEaD",
  RELAYER_PRIVATE_KEY: "0x" + "1".repeat(64),
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_CHAT_ID: "c",
} as unknown as Env;

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;

const sent: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = String(input);
  if (u.startsWith("https://api.telegram.org/")) {
    sent.push(JSON.parse(String(init?.body)).text);
    return new Response("{}", { status: 200 });
  }
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

function mcp(body: unknown, headers: Record<string, string> = {}, path = "/mcp"): Promise<Response> {
  return worker.fetch(
    new Request(`https://mcp.toolsnap.app${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx
  );
}

console.log("=== Fase E: D1 unavailable ===\n");

console.log("isD1Unavailable");
assert("recognises the real 7500 message", isD1Unavailable(new Error(D1_MSG)));
assert("recognises too many requests", isD1Unavailable(new Error("D1 too many requests queued")));
assert("ignores unrelated errors", !isD1Unavailable(new Error("boom")) && !isD1Unavailable(null));

console.log("\nfree path with D1 down");
{
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const j = (await init.json()) as { result?: unknown };
  assert("initialize → 200 with result", init.status === 200 && j.result !== undefined);
  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert("tools/list → 200", list.status === 200);
  const call = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tool_catalog", arguments: {} } });
  const cj = (await call.json()) as { result?: unknown; error?: unknown };
  assert("free tool_catalog → 200 result", call.status === 200 && cj.result !== undefined && !cj.error, JSON.stringify(cj).slice(0, 200));
  await Promise.allSettled(pending);
}

console.log("\nOAuth call with D1 down");
{
  const token = "oat_" + "A".repeat(43);
  for (const path of ["/mcp", "/mcp/oauth"]) {
    const res = await mcp(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tool_catalog", arguments: {} } },
      { authorization: `Bearer ${token}` },
      path
    );
    const j = (await res.json()) as { error?: { code: number; message: string; data?: { retry_after_utc?: string } } };
    assert(`${path}: -32000 readable error`, j.error?.code === -32000 && /temporarily unavailable/.test(j.error.message), JSON.stringify(j));
    assert(`${path}: data.retry_after_utc is a future ISO date`, Date.parse(j.error?.data?.retry_after_utc ?? "") > Date.now());
  }
}

console.log("\nGET /analytics/data with D1 down");
{
  const res = await worker.fetch(
    new Request("https://mcp.toolsnap.app/analytics/data", { headers: { "cf-access-authenticated-user-email": "a@b.c" } }),
    env,
    ctx
  );
  const j = (await res.json()) as { error?: string; reason?: string; retry_after_utc?: string };
  assert("503", res.status === 503, String(res.status));
  assert("body temporarily_unavailable / database quota", j.error === "temporarily_unavailable" && j.reason === "database quota" && !!j.retry_after_utc, JSON.stringify(j));
  assert("Retry-After header", Number(res.headers.get("retry-after")) > 0);
}

console.log("\nhealth cron with D1 down");
{
  let threw = false;
  try {
    await checkServerHealth(env);
    await checkServerHealth(env);
  } catch {
    threw = true;
  }
  assert("does not throw", !threw);
  assert("exactly one 🔴 alert (1h throttle)", sent.length === 1 && sent[0].includes("🔴") && sent[0].includes("D1 sin cuota"), JSON.stringify(sent));
}

globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
