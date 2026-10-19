/**
 * Unit tests for Fase 25.14 — KV writes that must stay best-effort.
 *
 * Incident 2026-10-19: the X402_NONCES namespace (the only KV binding) hit
 * the free-tier daily write limit (1,000 puts/day). The list_changed hint
 * written by tools/call tool_catalog(family=...) threw
 * "KV put() limit exceeded for the day." out of dispatch(), and every
 * tool_catalog(family=...) answered HTTP 500 "error code: 1101" for the rest
 * of the day — while tool_catalog() and tool_catalog(tool=...) kept working.
 *
 * Covers:
 *  - tools/call tool_catalog(family="utils") returns the family JSON (7 tools)
 *    with a KV whose put() AND get() throw.
 *  - tools/list with a session id still returns the curated core when the
 *    expanded-families read throws.
 *  - persistSessionClient / readSessionClient never throw.
 *  - maybeAlertError still pages (and does not reject inside waitUntil) when
 *    the throttle key can't be written.
 *
 * Pure logic — fake KV, fake D1, captured fetch. No network, no wrangler.
 *
 * Run: npx tsx test/kv-best-effort.ts
 */
import { dispatch } from "../src/mcp/server.js";
import { persistSessionClient, readSessionClient } from "../src/analytics/surface.js";
import { maybeAlertError } from "../src/alerts/error-alerts.js";
import { FAMILIES } from "../src/tools/catalog.js";
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

const QUOTA_ERROR = "KV put() limit exceeded for the day.";

/** A KV whose every operation throws, the way a quota-exhausted namespace does. */
function brokenKv(): KVNamespace {
  return {
    get: async () => {
      throw new Error("KV get() limit exceeded for the day.");
    },
    put: async () => {
      throw new Error(QUOTA_ERROR);
    },
    delete: async () => {
      throw new Error(QUOTA_ERROR);
    },
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

/** A KV that reads fine (always empty) but can't write — the exact 2026-10-19 state. */
function readOnlyKv(): KVNamespace {
  return {
    ...brokenKv(),
    get: async () => null,
  } as unknown as KVNamespace;
}

function makeCtx(): { ctx: ExecutionContext; settled: () => Promise<PromiseSettledResult<unknown>[]> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, settled: () => Promise.allSettled(pending) };
}

function makeEnv(kv: KVNamespace): Env {
  const d1 = {
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    }),
  };
  return {
    X402_NONCES: kv,
    PREPAID_DB: d1,
    ABUSE_RL: { limit: async () => ({ success: true }) },
    FREE_FETCH_RL: { limit: async () => ({ success: true }) },
    X402_NETWORK: "eip155:8453",
    X402_PRICE_USDC: "0.02",
    X402_PREPAID_PRICE_USDC: "0.01",
    X402_MIN_DEPOSIT_USDC: "0.50",
    BASE_RPC_URL: "https://mainnet.base.org",
    X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000dEaD",
    RELAYER_PRIVATE_KEY: "0x" + "1".repeat(64),
  } as unknown as Env;
}

type ToolResult = { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> }; error?: unknown };

async function callToolCatalogFamily(kv: KVNamespace, family: string): Promise<ToolResult> {
  const { ctx, settled } = makeCtx();
  const res = (await dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tool_catalog", arguments: { family } } },
    makeEnv(kv),
    false,
    ctx,
    "test-client/1.0",
    "session-kv-test-1"
  )) as ToolResult | null;
  const results = await settled();
  assert("no waitUntil promise rejected", results.every((r) => r.status === "fulfilled"));
  if (!res) throw new Error("dispatch returned null for a request with an id");
  return res;
}

console.log("=== Fase 25.14 KV best-effort tests ===\n");

console.log("tools/call tool_catalog(family=\"utils\") with a quota-exhausted KV");
for (const [label, kv] of [
  ["put() throws, get() reads empty (the 2026-10-19 state)", readOnlyKv()],
  ["put() and get() both throw", brokenKv()],
] as const) {
  console.log(`  · ${label}`);
  const res = await callToolCatalogFamily(kv, "utils");
  assert("responds with a result, not a JSON-RPC error", res.result !== undefined && res.error === undefined, JSON.stringify(res).slice(0, 200));
  assert("isError is not set", !res.result?.isError, JSON.stringify(res.result?.content?.[0]?.text).slice(0, 200));
  let parsed: { family?: string; tools?: unknown[] } = {};
  try {
    parsed = JSON.parse(res.result?.content?.[0]?.text ?? "{}");
  } catch {
    /* asserted below */
  }
  assert("payload is the utils family JSON", parsed.family === "utils", `family=${String(parsed.family)}`);
  assert(
    `lists all ${FAMILIES.utils.tools.length} utils tools`,
    Array.isArray(parsed.tools) && parsed.tools.length === FAMILIES.utils.tools.length,
    `got ${Array.isArray(parsed.tools) ? parsed.tools.length : "none"}`
  );
}

console.log("\ntools/list with a session id and a KV whose get() throws");
{
  const { ctx } = makeCtx();
  const res = (await dispatch(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    makeEnv(brokenKv()),
    false,
    ctx,
    "test-client/1.0",
    "session-kv-test-2"
  )) as ToolResult | null;
  const names = res?.result?.tools?.map((t) => t.name) ?? [];
  assert("returns the curated core", names.length > 0 && names.includes("tool_catalog"), `tools=${names.length}`);
}

console.log("\nsession client persistence never throws");
{
  let threw = false;
  try {
    await persistSessionClient(brokenKv(), "s1", { name: "x", version: "1" });
    const back = await readSessionClient(brokenKv(), "s1");
    assert("read falls back to null", back === null);
  } catch {
    threw = true;
  }
  assert("persist/read swallow KV failures", !threw);
}

console.log("\nsession client goes to the Cache API first, KV never written");
{
  const store = new Map<string, string>();
  const fakeCaches = {
    default: {
      put: async (req: Request, res: Response) => {
        store.set(req.url, await res.text());
      },
      match: async (req: Request) => {
        const v = store.get(req.url);
        return v === undefined ? undefined : new Response(v);
      },
    },
  };
  const g = globalThis as { caches?: unknown };
  const prev = g.caches;
  g.caches = fakeCaches;
  let kvPuts = 0;
  const countingKv = {
    ...readOnlyKv(),
    put: async () => {
      kvPuts++;
    },
  } as unknown as KVNamespace;
  try {
    await persistSessionClient(countingKv, "sess-cache-1", { name: "claude-desktop", version: "2.1" });
    const back = await readSessionClient(countingKv, "sess-cache-1");
    assert("reads back name/version from the cache", back?.name === "claude-desktop" && back?.version === "2.1", JSON.stringify(back));
    assert("KV put() was not called", kvPuts === 0, `kvPuts=${kvPuts}`);
    assert("unknown session reads null", (await readSessionClient(countingKv, "nope")) === null);
    assert("one cache entry per session", store.size === 1, `size=${store.size}`);
  } finally {
    g.caches = prev;
  }
}

console.log("\nmaybeAlertError with an unwritable throttle key");
{
  const realFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (async () => {
    sent++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { ctx, settled } = makeCtx();
    maybeAlertError({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c", X402_NONCES: readOnlyKv() }, ctx, {
      toolName: "fetch_extract",
      paymentType: "tool_error",
      payer: "anon:abc",
      client: "curl/8.0",
      clientName: "some-real-client",
      detail: "Microlink upstream 502",
    });
    const results = await settled();
    assert("waitUntil promise did not reject", results.every((r) => r.status === "fulfilled"));
    assert("alert still goes out (no-KV behaviour)", sent === 1, `sent=${sent}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
